import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import MapGL, { NavigationControl } from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, IconLayer, PathLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import carImageUrl from './assets/car.jpg';

interface Vehicle {
  id: number;
  x: number;
  y: number;
  angle: number;
  vitesse: number;
}

type Pos2 = [number, number];

type BBoxSelection = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

type IrisFeature = {
  properties?: Record<string, unknown> | null;
}

type IrisGeoJson = {
  type: 'FeatureCollection';
  features: IrisFeature[];
}

type MapLike = {
  getCanvas?: () => HTMLCanvasElement;
  unproject: (point: [number, number]) => { lng: number; lat: number };
  resize?: () => void;
}

interface MapViewerProps {
  vehicles: Vehicle[];
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
  onAddVehicle?: (lon: number, lat: number) => void;
  onRemoveVehicle?: (id: number) => void;
  isSelectingBbox?: boolean;
  onBboxSelected?: (bbox: BBoxSelection) => void;
  irisData?: IrisGeoJson | null;
  communeMotorizationByCode?: Map<string, number> | null;
  irisOpacity?: number;
}

// Taille de l'atlas (px) — la même pour l'image réelle et le fallback
const ATLAS_SIZE = 128;

const ICON_MAPPING = {
  car: { x: 0, y: 0, width: ATLAS_SIZE, height: ATLAS_SIZE, mask: false },
};

// Correction d'orientation : le nez de car.jpg pointe vers la droite (Est) → offset +90°
const CAR_ANGLE_OFFSET = 90;

const MAX_TRACE = 300;

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
    return [148, 163, 184, 80] as const; // Gris transparent
  }

  const alpha = 170;

  // Échelle de densité : du plus clair (peu) au plus foncé (beaucoup)
  if (value < 55) {
    return [255, 255, 178, alpha] as const; // Jaune pâle : très peu de voitures
  }
  if (value < 65) {
    return [254, 204, 92, alpha] as const;  // Jaune-Orange : peu de voitures
  }
  if (value < 75) {
    return [253, 141, 60, alpha] as const;  // Orange : moyenne
  }
  if (value < 85) {
    return [240, 59, 32, alpha] as const;   // Rouge : beaucoup de voitures
  }
  
  // value >= 85
  return [189, 0, 38, alpha] as const;      // Rouge foncé : énorme densité de voitures
};

function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) return 0;
  const latRad = lat1 * (Math.PI / 180);
  return Math.atan2(dLon * Math.cos(latRad), dLat) * (180 / Math.PI);
}

// Silhouette de fallback si l'image réelle n'est pas disponible
function buildFallbackAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ATLAS_SIZE;
  c.height = ATLAS_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.moveTo(64, 6);
  ctx.bezierCurveTo(84, 6, 92, 26, 92, 44);
  ctx.lineTo(92, 88);
  ctx.bezierCurveTo(92, 112, 78, 126, 64, 126);
  ctx.bezierCurveTo(50, 126, 36, 112, 36, 88);
  ctx.lineTo(36, 44);
  ctx.bezierCurveTo(36, 26, 44, 6, 64, 6);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.44;
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.moveTo(54, 22); ctx.lineTo(74, 22); ctx.lineTo(71, 46); ctx.lineTo(57, 46);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  return c;
}

// Charge /car-top.png, supprime le fond blanc par analyse pixel, renvoie le canvas
function loadCarAtlas(): Promise<HTMLCanvasElement> {
  return new Promise(resolve => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_SIZE;
      canvas.height = ATLAS_SIZE;
      const ctx = canvas.getContext('2d')!;

      // Centrer et scaler l'image dans le canvas
      const scale = Math.min(ATLAS_SIZE / img.width, ATLAS_SIZE / img.height) * 0.92;
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (ATLAS_SIZE - w) / 2, (ATLAS_SIZE - h) / 2, w, h);

      // Suppression du fond blanc/gris clair pixel par pixel
      const id = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const brightness = (r + g + b) / 3;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        if (brightness > 238 && saturation < 18) {
          d[i + 3] = 0; // pixel blanc pur → transparent
        } else if (brightness > 210 && saturation < 35) {
          // Zone de transition (ombre légère) → fondu
          d[i + 3] = Math.round(d[i + 3] * (1 - (brightness - 210) / 28));
        }
      }
      ctx.putImageData(id, 0, 0);
      resolve(canvas);
    };

    img.onerror = () => resolve(buildFallbackAtlas());
    img.src = carImageUrl;
  });
}

function speedColor(v: number): [number, number, number, number] {
  const s = Math.min(Math.max(v, 0), 120);
  if (s < 50) {
    const t = s / 50;
    return [30 + Math.round(t * 215), 220, 40, 240];
  }
  const t = (s - 50) / 70;
  return [245, Math.round(220 - t * 200), 40, 240];
}

function compassDir(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export const MapViewer: React.FC<MapViewerProps> = ({
  vehicles,
  initialLongitude = 7.5,
  initialLatitude = 48.3,
  initialZoom = 14,
  onAddVehicle,
  onRemoveVehicle,
  isSelectingBbox = false,
  onBboxSelected,
  irisData,
  communeMotorizationByCode,
  irisOpacity = 0.7,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLike | null>(null);
  const [viewState, setViewState] = useState({
    longitude: initialLongitude,
    latitude: initialLatitude,
    zoom: initialZoom,
    pitch: 45,
    bearing: 0,
  });

  const hasCenteredRef = useRef(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [traceOpacity, setTraceOpacity] = useState(0.82);
  const [is3D, setIs3D] = useState(true);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  const atlasRef = useRef<HTMLCanvasElement | null>(null);
  const [atlasReady, setAtlasReady] = useState(false);
  const traceRef = useRef<Pos2[]>([]);
  const prevPosRef = useRef<Map<number, Pos2>>(new Map());
  const anglesRef = useRef<Map<number, number>>(new Map());
  // Vecteurs unitaires (cos, sin) pour le lissage circulaire de l'angle
  const angleVecRef = useRef<Map<number, [number, number]>>(new Map());

  useEffect(() => {
    loadCarAtlas().then(canvas => {
      atlasRef.current = canvas;
      setAtlasReady(true);
    });
  }, []);

  useEffect(() => {
    if (!isSelectingBbox) {
      setDragStart(null);
      setDragCurrent(null);
    }
  }, [isSelectingBbox]);

  useEffect(() => {
    if (vehicles.length !== 0) {
      return;
    }

    hasCenteredRef.current = false;

    if (selectedId !== null) {
      setSelectedId(null);
    }

    traceRef.current = [];
    prevPosRef.current.clear();
    anglesRef.current.clear();
    angleVecRef.current.clear();
  }, [vehicles.length, selectedId]);

  useEffect(() => {
    const syncMapSize = () => {
      mapRef.current?.resize?.();
    };

    const frameId = window.requestAnimationFrame(syncMapSize);
    window.addEventListener('resize', syncMapSize);

    const observer =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(() => syncMapSize())
        : null;

    if (observer && containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', syncMapSize);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (hasCenteredRef.current || vehicles.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of vehicles) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    setViewState(s => ({ ...s, longitude: (minX + maxX) / 2, latitude: (minY + maxY) / 2 }));
    hasCenteredRef.current = true;
  }, [vehicles]);

  useEffect(() => {
    const ALPHA = 0.3;      // lissage : 0 = figé, 1 = instantané
    const MIN_DIST = 1e-6;  // ~0.1 m — ignore les micro-tremblements

    for (const v of vehicles) {
      const prev = prevPosRef.current.get(v.id);
      if (prev) {
        const dLon = v.x - prev[0];
        const dLat = v.y - prev[1];
        if (Math.abs(dLon) > MIN_DIST || Math.abs(dLat) > MIN_DIST) {
          const b = bearing(prev[0], prev[1], v.x, v.y);
          const rad = b * (Math.PI / 180);
          const nc = Math.cos(rad);
          const ns = Math.sin(rad);

          const vec = angleVecRef.current.get(v.id);
          if (vec) {
            // EMA sur vecteur unitaire → pas de saut circulaire (ex. -179° → +179°)
            const sc = vec[0] * (1 - ALPHA) + nc * ALPHA;
            const ss = vec[1] * (1 - ALPHA) + ns * ALPHA;
            angleVecRef.current.set(v.id, [sc, ss]);
            anglesRef.current.set(v.id, Math.atan2(ss, sc) * (180 / Math.PI));
          } else {
            angleVecRef.current.set(v.id, [nc, ns]);
            anglesRef.current.set(v.id, b);
          }
        }
      }
      prevPosRef.current.set(v.id, [v.x, v.y]);
    }
  }, [vehicles]);

  useEffect(() => {
    if (selectedId === null) return;
    const v = vehicles.find(v => v.id === selectedId);
    if (!v) return;
    traceRef.current = [...traceRef.current, [v.x, v.y] as Pos2].slice(-MAX_TRACE);
  }, [vehicles, selectedId]);

  const selectedVehicle = useMemo(
    () => (selectedId !== null ? (vehicles.find(v => v.id === selectedId) ?? null) : null),
    [vehicles, selectedId]
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

  const getRelativePoint = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;

    if (!container) {
      return null;
    }

    const rect = container.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }, []);

  const handleSelectionMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
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
  }, [getRelativePoint, isSelectingBbox]);

  const handleSelectionMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
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
  }, [dragStart, getRelativePoint, isSelectingBbox]);

  const handleSelectionMouseUp = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
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
  }, [dragCurrent, dragStart, isSelectingBbox, onBboxSelected]);

  const selectionRect = useMemo(() => {
    if (!dragStart || !dragCurrent) {
      return null;
    }

    const left = Math.min(dragStart.x, dragCurrent.x);
    const top = Math.min(dragStart.y, dragCurrent.y);
    const width = Math.abs(dragCurrent.x - dragStart.x);
    const height = Math.abs(dragCurrent.y - dragStart.y);

    return { left, top, width, height };
  }, [dragCurrent, dragStart]);

  const onDeckClick = useCallback((info: any) => {
    if (isSelectingBbox) {
      return;
    }

    if (info.picked && info.layer?.id === 'vehicles' && info.object) {
      const id = (info.object as Vehicle).id;
      if (id === selectedId) { setSelectedId(null); traceRef.current = []; }
      else { setSelectedId(id); traceRef.current = [[info.object.x, info.object.y]]; }
    } else if (info.coordinate) {
      onAddVehicle?.(info.coordinate[0], info.coordinate[1]);
    }
  }, [isSelectingBbox, onAddVehicle, selectedId]);

  const closePanel = useCallback(() => { setSelectedId(null); traceRef.current = []; }, []);

  const toggle3D = useCallback(() => {
    setIs3D(prev => {
      const next = !prev;
      setViewState(s => ({ ...s, pitch: next ? 45 : 0 }));
      return next;
    });
  }, []);

  const layers = useMemo(() => {
    void atlasReady;
    const result: any[] = [];

    if (irisLayer) {
      result.push(irisLayer);
    }

    if (selectedId !== null && traceRef.current.length >= 2) {
      result.push(new PathLayer({
        id: 'trace',
        data: [{ path: traceRef.current }],
        getPath: (d: any) => d.path,
        getColor: [64, 200, 255, Math.round(traceOpacity * 255)],
        getWidth: 5,
        widthMinPixels: 2,
        widthMaxPixels: 14,
        capRounded: true,
        jointRounded: true,
      }));
    }

    if (atlasRef.current) {
      result.push(new IconLayer({
        id: 'vehicles',
        data: vehicles,
        pickable: true,
        iconAtlas: atlasRef.current,
        iconMapping: ICON_MAPPING,
        getIcon: () => 'car',
        
        getPosition: (d: Vehicle) => [d.x, d.y, 5], 
        
        getSize: (d: Vehicle) => (d.id === selectedId ? 42 : 28),
        getAngle: (d: Vehicle) => -(anglesRef.current.get(d.id) ?? 0) + CAR_ANGLE_OFFSET,
        getColor: (d: Vehicle) =>
          d.id === selectedId
            ? ([255, 230, 60, 255] as [number, number, number, number])
            : ([255, 255, 255, 220] as [number, number, number, number]),
            
        parameters: {
          depthTest: false
        },

        updateTriggers: {
          getColor: [selectedId],
          getAngle: vehicles.length,
          getSize: selectedId,
        },
        transitions: { getPosition: { duration: 200 } },
      }));
    }

    return result;
  }, [atlasReady, irisLayer, selectedId, traceOpacity, vehicles]);

  const avgSpeed = useMemo(
    () => vehicles.length > 0
      ? Math.round(vehicles.reduce((a, v) => a + v.vitesse, 0) / vehicles.length)
      : 0,
    [vehicles]
  );

  const selectedColor = selectedVehicle
    ? speedColor(selectedVehicle.vitesse)
    : ([255, 255, 255, 255] as [number, number, number, number]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: isSelectingBbox ? 'crosshair' : undefined,
      }}
      onContextMenu={e => e.preventDefault()}
      onMouseDown={handleSelectionMouseDown}
      onMouseMove={handleSelectionMouseMove}
      onMouseUp={handleSelectionMouseUp}
    >
      <MapGL
        {...viewState}
        onMove={(e: any) => setViewState(e.viewState)}
        onLoad={(event) => {
          mapRef.current = event.target;
          window.requestAnimationFrame(() => {
            mapRef.current?.resize?.();
          });
        }}
        mapStyle="https://tiles.openfreemap.org/styles/liberty"
        attributionControl={false}
        style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
      >
        <NavigationControl position="top-left" />

        <DeckGL
          viewState={viewState}
          controller={{ dragPan: !isSelectingBbox, dragRotate: !isSelectingBbox }}
          layers={layers}
          onViewStateChange={(e: any) => setViewState(e.viewState)}
          onClick={onDeckClick}
          style={{ width: '100%', height: '100%' }}
          getCursor={({ isDragging, isHovering }: any) =>
            isSelectingBbox
              ? 'crosshair'
              : isDragging
                ? 'grabbing'
                : isHovering
                  ? 'pointer'
                  : 'crosshair'
          }
          getTooltip={({ object, layer }: { object?: IrisFeature | null; layer?: { id?: string } | null }) => {
            if (!object || !communeMotorizationByCode || layer?.id !== 'iris-layer') {
              return null;
            }

            const codeIris = extractFeatureCode(object as IrisFeature);

            if (!codeIris) {
              return null;
            }

            const rate = communeMotorizationByCode.get(codeIris) ?? null;

            if (rate === null || Number.isNaN(rate)) {
              return {
                html: `<div style="font-style: italic; opacity: 0.8;">Données indisponibles pour cette zone</div>`
              };
            }

            return {
              html: `
                <div style="font-weight:700; font-size:2.0em; margin-bottom:2px; color:#38bdf8;">
                  ${formatPercentage(rate)}
                </div>
                <div style="font-size:1.3em; opacity:0.9;">
                  des foyers possèdent au moins une voiture
                </div>
              `,
            };
          }}
        />
      </MapGL>

      <div className="map-panel stats-panel">
        <div className="stat-row">
          <span className="stat-label">Véhicules</span>
          <span className="stat-value">{vehicles.length.toLocaleString('fr-FR')}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Vit. moy.</span>
          <span className="stat-value">{avgSpeed}<span className="stat-unit"> km/h</span></span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Zoom</span>
          <span className="stat-value">{viewState.zoom.toFixed(1)}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Incl.</span>
          <span className="stat-value">{Math.round(viewState.pitch)}°</span>
        </div>
        <button className={`btn-toggle-3d${is3D ? ' active' : ''}`} onClick={toggle3D} title="Basculer vue 3D / 2D">
          {is3D ? 'Vue 2D' : 'Vue 3D'}
        </button>
      </div>

      {selectedVehicle && (
        <div className="map-panel vehicle-panel">
          <div className="vp-header">
            <div className="vp-id-block">
              <span className="vp-label">Véhicule</span>
              <span className="vp-id">#{selectedVehicle.id}</span>
            </div>
            <button className="btn-close" onClick={closePanel} title="Fermer">✕</button>
          </div>
          <div className="vp-speed-block">
            <span className="vp-speed-value" style={{ color: `rgb(${selectedColor[0]},${selectedColor[1]},${selectedColor[2]})` }}>
              {Math.round(selectedVehicle.vitesse)}
            </span>
            <span className="vp-speed-unit">km/h</span>
          </div>
          <div className="vp-grid">
            <div className="stat-row">
              <span className="stat-label">Cap</span>
              <span className="stat-value">
                {(() => { const a = anglesRef.current.get(selectedVehicle.id) ?? 0; return `${Math.round(((a % 360) + 360) % 360)}°`; })()}&nbsp;
                <span className="stat-compass">{compassDir(anglesRef.current.get(selectedVehicle.id) ?? 0)}</span>
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Tracé</span>
              <span className="stat-value">{traceRef.current.length}&nbsp;<span className="stat-unit">pts</span></span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Lon</span>
              <span className="stat-value mono">{selectedVehicle.x.toFixed(5)}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Lat</span>
              <span className="stat-value mono">{selectedVehicle.y.toFixed(5)}</span>
            </div>
          </div>
          <div className="vp-opacity-section">
            <div className="vp-opacity-header">
              <span className="stat-label">Opacité du tracé</span>
              <span className="stat-value">{Math.round(traceOpacity * 100)}%</span>
            </div>
            <div className="opacity-track">
              <input
                type="range" min={0} max={100}
                value={Math.round(traceOpacity * 100)}
                onChange={e => setTraceOpacity(Number(e.target.value) / 100)}
                className="opacity-slider"
                style={{ '--pct': Math.round(traceOpacity * 100) } as React.CSSProperties}
              />
            </div>
          </div>
          <button
            className="btn-remove-vehicle"
            onClick={() => { onRemoveVehicle?.(selectedVehicle.id); closePanel(); }}
          >
            Supprimer ce véhicule
          </button>
        </div>
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
          Cliquer-dragger sur la carte pour sélectionner une zone
        </div>
      )}

      {!selectedVehicle && vehicles.length > 0 && (
        <div className="click-hint">Clic sur un véhicule pour le sélectionner · Clic sur la carte pour en ajouter un</div>
      )}

      <div className="map-attribution">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
        &nbsp;· OpenFreeMap
      </div>
    </div>
  );
};
