import React, { useEffect, useMemo, useRef, useState } from 'react';
import MapGL, { NavigationControl } from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

interface Vehicle {
  id: number;
  x: number;
  y: number;
  angle: number;
  vitesse: number;
}

interface BBoxSelection {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

type IrisFeature = {
  properties?: Record<string, unknown> | null;
};

type IrisGeoJson = {
  type: 'FeatureCollection';
  features: IrisFeature[];
};

type MapLike = {
  getCanvas?: () => HTMLCanvasElement;
  unproject: (point: [number, number]) => { lng: number; lat: number };
};

interface MapViewerProps {
  vehicles: Vehicle[];
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
  isSelectingBbox?: boolean;
  onBboxSelected?: (bbox: BBoxSelection) => void;
  irisData?: IrisGeoJson | null;
  communeMotorizationByCode?: Map<string, number> | null;
  irisOpacity?: number;
}

const normalizeText = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const readString = (value: unknown) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
};

const extractFeatureCode = (feature: IrisFeature) => {
  const properties = feature.properties;
  if (!properties) {
    return '';
  }

  const preferredKeys = [
    'CODE_IRIS',
    'code_iris',
    'CODEINSEE',
    'code_insee',
    'CODE_GEO',
    'code_geo',
    'CODGEO',
    'codgeo',
    'IRIS',
    'iris',
  ];

  for (const key of preferredKeys) {
    const rawValue = properties[key];
    const code = readString(rawValue);

    if (code) {
      return code;
    }
  }

  for (const [key, rawValue] of Object.entries(properties)) {
    const normalizedKey = normalizeText(key);

    if (normalizedKey.includes('iris') || normalizedKey.includes('code') || normalizedKey.includes('geo')) {
      const code = readString(rawValue);
      if (code) {
        return code;
      }
    }
  }

  return '';
};

const formatPercentage = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return 'indisponible';
  }

  return `${value.toFixed(1)} %`;
};

const colorFromRate = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return [148, 163, 184, 80] as const;
  }

  const ratio = Math.max(0, Math.min(1, value / 100));
  const red = Math.round(60 + ratio * 180);
  const green = Math.round(180 - ratio * 120);
  const blue = Math.round(90 - ratio * 60);

  return [red, green, blue, 170] as const;
};

export const MapViewer: React.FC<MapViewerProps> = ({
  vehicles,
  initialLongitude = 7.5,
  initialLatitude = 48.3,
  initialZoom = 11,
  isSelectingBbox = false,
  onBboxSelected,
  irisData,
  communeMotorizationByCode,
  irisOpacity = 0.7,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLike | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewState, setViewState] = useState({
    longitude: initialLongitude,
    latitude: initialLatitude,
    zoom: initialZoom,
    pitch: 0,
    bearing: 0,
  });

  const hasCenteredRef = useRef(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  const sameViewState = (a: typeof viewState, b: typeof viewState) =>
    a.longitude === b.longitude &&
    a.latitude === b.latitude &&
    a.zoom === b.zoom &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const updateSize = () => {
      const { width, height } = container.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
      });
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);

      return () => {
        window.removeEventListener('resize', updateSize);
      };
    }

    const observer = new ResizeObserver(() => {
      updateSize();
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  //ce hook s'active des que la liste des vehicules change
  useEffect(() => {
    if (hasCenteredRef.current || vehicles.length === 0) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;

      for (const v of vehicles) {
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }

      //on calcule le centre de tous les véhicules
      const centerLon = (minX + maxX) / 2;
      const centerLat = (minY + maxY) / 2;

      //on met à jour la caméra
      setViewState(prev => ({
        ...prev,
        longitude: centerLon,
        latitude: centerLat
      }));
      hasCenteredRef.current = true;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [vehicles]);

  const mapStyle = useMemo(
    () => ({
      version: 8 as const,
      sources: {
        osm: {
          type: 'raster' as const,
          tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
        },
      },
      layers: [
        {
          id: 'osm',
          type: 'raster' as const,
          source: 'osm',
        },
      ],
    }),
    [],
  );

  const irisLayer = useMemo(() => {
    if (!irisData || !communeMotorizationByCode) {
      return null;
    }

    return new GeoJsonLayer({
      id: 'iris-layer',
      data: irisData,
      pickable: true,
      stroked: true,
      filled: true,
      opacity: irisOpacity,
      getFillColor: (feature: IrisFeature) => {
        const codeIris = extractFeatureCode(feature);

        if (!codeIris) {
          return colorFromRate(null);
        }

            const rate = communeMotorizationByCode.get(codeIris) ?? null;

        return colorFromRate(rate);
      },
      getLineColor: [20, 24, 39, 180],
      lineWidthMinPixels: 1,
      updateTriggers: {
        getFillColor: [communeMotorizationByCode],
      },
    });
  }, [communeMotorizationByCode, irisData, irisOpacity]);

  const layers = useMemo(
    () => [
      ...(irisLayer ? [irisLayer] : []),
      new ScatterplotLayer({
        id: 'vehicle-layer',
        data: vehicles,
        pickable: true,
        opacity: 0.9,
        radiusScale: 2.2,
        radiusMinPixels: 3,
        radiusMaxPixels: 14,
        getPosition: (d: Vehicle) => [d.x, d.y],
        getRadius: 3,
        getFillColor: (d: Vehicle) => {
          const speed = Math.min(d.vitesse, 100);
          return [255 - speed * 2, speed * 2, 0, 200];
        },
        getLineColor: [0, 0, 0, 255],
        lineWidthMinPixels: 1,
        updateTriggers: {
          getPosition: [vehicles],
          getFillColor: [vehicles],
        },
        transitions: {
          getPosition: {
            duration: 180,
            easing: (t: number) => t,
          },
        },
      }),
    ],
    [irisLayer, vehicles],
  );

  const handleMapContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const getRelativePoint = (event: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) {
      return null;
    }

    const rect = container.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const handleSelectionMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelectingBbox || event.button !== 0) {
      return;
    }

    const point = getRelativePoint(event);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragStart(point);
    setDragCurrent(point);
  };

  const handleSelectionMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelectingBbox || !dragStart) {
      return;
    }

    const point = getRelativePoint(event);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragCurrent(point);
  };

  const handleSelectionMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelectingBbox || !dragStart || !dragCurrent || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const map = mapRef.current;
    if (!map) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }

    const minX = Math.min(dragStart.x, dragCurrent.x);
    const maxX = Math.max(dragStart.x, dragCurrent.x);
    const minY = Math.min(dragStart.y, dragCurrent.y);
    const maxY = Math.max(dragStart.y, dragCurrent.y);

    if (Math.abs(maxX - minX) < 6 || Math.abs(maxY - minY) < 6) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }

    const northWest = map.unproject([minX, minY]);
    const southEast = map.unproject([maxX, maxY]);

    onBboxSelected?.({
      minLon: Math.min(northWest.lng, southEast.lng),
      minLat: Math.min(northWest.lat, southEast.lat),
      maxLon: Math.max(northWest.lng, southEast.lng),
      maxLat: Math.max(northWest.lat, southEast.lat),
    });

    setDragStart(null);
    setDragCurrent(null);
  };

  const selectionRect = useMemo(() => {
    if (!dragStart || !dragCurrent) {
      return null;
    }

    const left = Math.min(dragStart.x, dragCurrent.x);
    const top = Math.min(dragStart.y, dragCurrent.y);
    const width = Math.abs(dragCurrent.x - dragStart.x);
    const height = Math.abs(dragCurrent.y - dragStart.y);

    return { left, top, width, height };
  }, [dragStart, dragCurrent]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof map.getCanvas !== 'function') {
      return;
    }

    const canvas = map.getCanvas();
    canvas.style.cursor = isSelectingBbox ? 'crosshair' : '';
  }, [isSelectingBbox]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: isSelectingBbox ? 'crosshair' : undefined,
      }}
      onContextMenu={handleMapContextMenu}
      onMouseDown={handleSelectionMouseDown}
      onMouseMove={handleSelectionMouseMove}
      onMouseUp={handleSelectionMouseUp}
    >
      {size.width > 0 && size.height > 0 && (
        <DeckGL
          viewState={viewState}
          controller={{ dragPan: !isSelectingBbox, dragRotate: !isSelectingBbox }}
          getCursor={({ isDragging }: { isDragging: boolean }) => {
            if (isSelectingBbox) {
              return 'crosshair';
            }

            return isDragging ? 'grabbing' : 'grab';
          }}
          layers={layers}
          getTooltip={({ object }: { object?: IrisFeature | null }) => {
            if (!object || !communeMotorizationByCode) {
              return null;
            }

            const feature = object as IrisFeature;
            const codeIris = extractFeatureCode(feature);

            if (!codeIris) {
              return null;
            }

            const rate = communeMotorizationByCode.get(codeIris) ?? null;

            return {
              html: `
                <div style="font-weight:700;margin-bottom:4px;">IRIS ${codeIris}</div>
                <div>Taux de motorisation: ${formatPercentage(rate)}</div>
              `,
            };
          }}
          onViewStateChange={({ viewState: nextViewState }: { viewState: typeof viewState }) => {
            const normalizedViewState = nextViewState as typeof viewState;

            if (!sameViewState(viewState, normalizedViewState)) {
              setViewState(normalizedViewState);
            }
          }}
          width={size.width}
          height={size.height}
          style={{ position: 'absolute', inset: 0 }}
        >
          <MapGL
            {...viewState}
            onLoad={(event) => {
              mapRef.current = event.target;
            }}
            mapStyle={mapStyle}
            attributionControl={true}
            reuseMaps={true}
            style={{ position: 'absolute', inset: 0 }}
          >
            <NavigationControl position="top-left" />
            <div
              style={{
                position: 'absolute',
                bottom: 10,
                left: 10,
                background: 'rgba(255, 255, 255, 0.8)',
                padding: '8px 12px',
                borderRadius: '4px',
                fontSize: '12px',
                zIndex: 10,
              }}
            >
              © OpenStreetMap contributors
            </div>
          </MapGL>
        </DeckGL>
      )}

      {selectionRect && (
        <div
          style={{
            position: 'absolute',
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
            border: '2px solid rgba(56, 189, 248, 0.95)',
            background: 'rgba(56, 189, 248, 0.2)',
            boxShadow: '0 0 0 1px rgba(2, 132, 199, 0.45) inset',
            pointerEvents: 'none',
            zIndex: 30,
          }}
        />
      )}

      {isSelectingBbox && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(15, 23, 42, 0.9)',
            color: '#f8fafc',
            padding: '8px 12px',
            borderRadius: '999px',
            fontSize: '12px',
            zIndex: 35,
            border: '1px solid rgba(148, 163, 184, 0.35)',
          }}
        >
          Cliquer-déplacer la souris sur la carte pour sélectionner une zone
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          padding: '12px',
          borderRadius: '4px',
          fontSize: '12px',
          zIndex: 10,
          minWidth: '200px',
        }}
      >
        <div>Zoom: {Math.round(viewState.zoom * 10) / 10}</div>
        <div>Voitures visibles: {vehicles.length}</div>
        {vehicles.length > 0 && (
          <div>
            Vitesse moy:{' '}
            {Math.round(
              vehicles.reduce((acc, v) => acc + v.vitesse, 0) / vehicles.length
            )}{' '}
            km/h
          </div>
        )}
      </div>
    </div>
  );
};