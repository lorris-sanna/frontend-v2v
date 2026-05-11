import React, { useEffect, useMemo, useRef, useState } from 'react';
import MapGL, { NavigationControl } from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

interface Vehicle {
  id: number;
  x: number;
  y: number;
  angle: number;
  vitesse: number;
}

interface MapViewerProps {
  vehicles: Vehicle[];
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
}

export const MapViewer: React.FC<MapViewerProps> = ({
  vehicles,
  initialLongitude = 7.5,
  initialLatitude = 48.3,
  initialZoom = 11,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewState, setViewState] = useState({
    longitude: initialLongitude,
    latitude: initialLatitude,
    zoom: initialZoom,
    pitch: 0,
    bearing: 0,
  });

  const hasCenteredRef = useRef(false);

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

  const layers = useMemo(
    () => [
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
        transitions: {
          getPosition: {
            duration: 180,
            easing: (t: number) => t,
          },
        },
      }),
    ],
    [vehicles],
  );

  const handleMapContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleMapMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onContextMenu={handleMapContextMenu}
      onMouseUp={handleMapMouseUp}
    >
      {size.width > 0 && size.height > 0 && (
        <DeckGL
          viewState={viewState}
          controller={true}
          layers={layers}
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