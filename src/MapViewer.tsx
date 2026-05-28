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
  isRespawning?: boolean;
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
  getStyle?: () => { layers?: Array<{ id: string; type: string }> };
  setLayoutProperty?: (layerId: string, name: string, value: unknown) => void;
}

interface MapViewerProps {
  vehicles: Vehicle[];
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
  sidebarVisibleWidth?: number;
  onAddVehicle?: (lon: number, lat: number) => void;
  onRemoveVehicle?: (id: number) => void;
  isSelectingBbox?: boolean;
  onBboxSelected?: (bbox: BBoxSelection) => void;
  irisData?: IrisGeoJson | null;
  communeMotorizationByCode?: Map<string, number> | null;
  dynamicIrisEnabled?: boolean;
  irisOpacity?: number;
  flat?: boolean;
}

//taille de l'atlas en px
const ATLAS_SIZE = 128;

const ICON_MAPPING = {
  car: { x: 0, y: 0, width: ATLAS_SIZE, height: ATLAS_SIZE, mask: false },
};

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

const computeFeatureBounds = (geometry: unknown): BBoxSelection | null => {
  if (!geometry || typeof geometry !== 'object') return null;
  const coords = (geometry as any).coordinates;
  if (!Array.isArray(coords)) return null;

  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;

  const flattenCoords = (arr: unknown[]) => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      if (arr[0] < minLon) minLon = arr[0];
      if (arr[0] > maxLon) maxLon = arr[0];
      if (arr[1] < minLat) minLat = arr[1];
      if (arr[1] > maxLat) maxLat = arr[1];
    } else {
      arr.forEach(item => flattenCoords(item as unknown[]));
    }
  };
  
  flattenCoords(coords);
  if (minLon === Infinity) return null;
  return { minLon, minLat, maxLon, maxLat };
};

const pointInRing = (point: [number, number], ring: unknown): boolean => {
  if (!Array.isArray(ring)) {
    return false;
  }

  let inside = false;
  const [x, y] = point;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];

    if (
      !Array.isArray(currentPoint) ||
      !Array.isArray(previousPoint) ||
      typeof currentPoint[0] !== 'number' ||
      typeof currentPoint[1] !== 'number' ||
      typeof previousPoint[0] !== 'number' ||
      typeof previousPoint[1] !== 'number'
    ) {
      continue;
    }

    const currentX = currentPoint[0];
    const currentY = currentPoint[1];
    const previousX = previousPoint[0];
    const previousY = previousPoint[1];

    const intersects =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
};

const pointInPolygon = (point: [number, number], polygon: unknown): boolean => {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    return false;
  }

  if (!pointInRing(point, polygon[0])) {
    return false;
  }

  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(point, polygon[index])) {
      return false;
    }
  }

  return true;
};

const pointInGeometry = (point: [number, number], geometry: unknown): boolean => {
  if (!geometry || typeof geometry !== 'object') {
    return false;
  }

  const typedGeometry = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  const type = String(typedGeometry.type ?? '').trim();

  if (type === 'Polygon') {
    return pointInPolygon(point, typedGeometry.coordinates);
  }

  if (type === 'MultiPolygon' && Array.isArray(typedGeometry.coordinates)) {
    return typedGeometry.coordinates.some(polygon => pointInPolygon(point, polygon));
  }

  if (type === 'GeometryCollection' && Array.isArray(typedGeometry.geometries)) {
    return typedGeometry.geometries.some(subGeometry => pointInGeometry(point, subGeometry));
  }

  return false;
};

const formatPercentage = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return 'indisponible';
  }

  return `${value.toFixed(1)} %`;
};

const colorFromRate = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return [148, 163, 184, 80] as const; //gris transparent
  }

  const alpha = 170;

  //du plus clair au plus foncé
  if (value < 55) {
    return [255, 255, 178, alpha] as const; //jaune clair, très peu de voitures
  }
  if (value < 65) {
    return [254, 204, 92, alpha] as const;  //jaune fonce, peu de voitures
  }
  if (value < 75) {
    return [253, 141, 60, alpha] as const;  //orange, moyenne
  }
  if (value < 85) {
    return [240, 59, 32, alpha] as const;   //rouge, beaucoup de voitures
  }
  
  return [189, 0, 38, alpha] as const;      //rouge fonce, enormement de voitures
};

const colorFromDynamicRate = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return [148, 163, 184, 80] as const;
  }

  const alpha = 170;

  if (value < 1) {
    return [255, 255, 178, alpha] as const;
  }
  if (value < 2.5) {
    return [254, 204, 92, alpha] as const;
  }
  if (value < 5) {
    return [253, 141, 60, alpha] as const;
  }
  if (value < 10) {
    return [240, 59, 32, alpha] as const;
  }
  
  return [189, 0, 38, alpha] as const;
};

function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) return 0;
  const latRad = lat1 * (Math.PI / 180);
  return Math.atan2(dLon * Math.cos(latRad), dLat) * (180 / Math.PI);
}

//fallback si l'image reelle n'est pas disponible
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

//charge /car-top.png, supprime le fond blanc, renvoie le canvas
function loadCarAtlas(): Promise<HTMLCanvasElement> {
  return new Promise(resolve => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_SIZE;
      canvas.height = ATLAS_SIZE;
      const ctx = canvas.getContext('2d')!;

      const scale = Math.min(ATLAS_SIZE / img.width, ATLAS_SIZE / img.height) * 0.92;
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (ATLAS_SIZE - w) / 2, (ATLAS_SIZE - h) / 2, w, h);

      const id = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const brightness = (r + g + b) / 3;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        if (brightness > 238 && saturation < 18) {
          d[i + 3] = 0;
        } else if (brightness > 210 && saturation < 35) {
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
  sidebarVisibleWidth = 0,
  onAddVehicle,
  onRemoveVehicle,
  isSelectingBbox = false,
  onBboxSelected,
  irisData,
  communeMotorizationByCode,
  dynamicIrisEnabled = false,
  irisOpacity = 0.7,
  flat = false,
}) => {
  const hintsCenterLeft = `calc(50% + ${Math.max(0, sidebarVisibleWidth) / 2}px)`;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLike | null>(null);

  const [hoveredIris, setHoveredIris] = useState<{ feature: IrisFeature; x: number; y: number } | null>(null);

  const [viewState, setViewState] = useState({
    longitude: initialLongitude,
    latitude: initialLatitude,
    zoom: initialZoom,
    pitch: 45,
    bearing: 0,
  });

  const hasCenteredRef = useRef(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [traceOpacity, setTraceOpacity] = useState(1.00);
  const [isLeftMouseDown, setIsLeftMouseDown] = useState(false);
  const [isHoveringVehicle, setIsHoveringVehicle] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  const atlasRef = useRef<HTMLCanvasElement | null>(null);
  const [atlasReady, setAtlasReady] = useState(false);
  const traceRef = useRef<Pos2[]>([]);
  const anglesRef = useRef<Map<number, number>>(new Map());
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
    const ALPHA = 0.5;

    for (const v of vehicles) {
      if (v.isRespawning) {
        prevPosRef.current.delete(v.id);
        anglesRef.current.delete(v.id);
        angleVecRef.current.delete(v.id);
        continue;
      }

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
            const sc = vec[0] * (1 - ALPHA) + nc * ALPHA;
            const ss = vec[1] * (1 - ALPHA) + ns * ALPHA;
            angleVecRef.current.set(v.id, [sc, ss]);
            anglesRef.current.set(v.id, Math.atan2(ss, sc) * (180 / Math.PI));
          } else {
            angleVecRef.current.set(v.id, [nc, ns]);
            anglesRef.current.set(v.id, b);
          }
        }
      const b = v.angle;
      const rad = b * (Math.PI / 180);
      const nc = Math.cos(rad);
      const ns = Math.sin(rad);

      const vec = angleVecRef.current.get(v.id);
      if (vec) {
        const sc = vec[0] * (1 - ALPHA) + nc * ALPHA;
        const ss = vec[1] * (1 - ALPHA) + ns * ALPHA;
        angleVecRef.current.set(v.id, [sc, ss]);
        anglesRef.current.set(v.id, Math.atan2(ss, sc) * (180 / Math.PI));
      } else {
        angleVecRef.current.set(v.id, [nc, ns]);
        anglesRef.current.set(v.id, b);
      }
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

  const vehiclesRef = useRef(vehicles);
  useEffect(() => {
    vehiclesRef.current = vehicles;
  }, [vehicles]);

  const irisBoundsCache = useMemo(() => {
    const cache = new Map<IrisFeature, BBoxSelection>();
    
    if (dynamicIrisEnabled && irisData?.features) {
      for (const feature of irisData.features) {
        const bounds = computeFeatureBounds((feature as any).geometry);
        if (bounds) cache.set(feature, bounds);
      }
    }
    return cache;
  }, [irisData, dynamicIrisEnabled]);

  const [dynamicIrisPresenceByCode, setDynamicIrisPresenceByCode] = useState<Map<string, { count: number; percentage: number }> | null>(null);

  useEffect(() => {
    if (!dynamicIrisEnabled || !irisData) {
      setDynamicIrisPresenceByCode(null);
      return;
    }

    const calculate = () => {
      const currentVehicles = vehiclesRef.current;
      const totalVehicles = currentVehicles.length;
      
      if (totalVehicles === 0) {
        setDynamicIrisPresenceByCode(null);
        return;
      }

      const valuesByCode = new Map<string, { count: number; percentage: number }>();

      for (const feature of irisData.features) {
        const codeIris = extractFeatureCode(feature);
        if (!codeIris) continue;

        let vehiclesInZone = 0;
        const geometry = (feature as Record<string, unknown>).geometry;
        const bounds = irisBoundsCache.get(feature);

        for (const vehicle of currentVehicles) {
          if (bounds) {
            if (
              vehicle.x < bounds.minLon || vehicle.x > bounds.maxLon ||
              vehicle.y < bounds.minLat || vehicle.y > bounds.maxLat
            ) {
              continue; 
            }
          }
          if (pointInGeometry([vehicle.x, vehicle.y], geometry)) {
            vehiclesInZone += 1;
          }
        }

        valuesByCode.set(codeIris, { 
          count: vehiclesInZone, 
          percentage: (vehiclesInZone / totalVehicles) * 100 
        });
      }
      
      setDynamicIrisPresenceByCode(valuesByCode);
    };

    calculate();

    const intervalId = setInterval(calculate, 500);
    return () => clearInterval(intervalId);
    
  }, [dynamicIrisEnabled, irisData, irisBoundsCache]);

  const activeIrisMetricsByCode = dynamicIrisEnabled ? dynamicIrisPresenceByCode : communeMotorizationByCode;

  const irisLayer = useMemo(() => {
    if (!irisData || (!dynamicIrisEnabled && !communeMotorizationByCode)) {
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
        if (!codeIris) return [148, 163, 184, 80] as const;

        //mode dynamique
        if (dynamicIrisEnabled && dynamicIrisPresenceByCode) {
          const data = dynamicIrisPresenceByCode.get(codeIris);
          return colorFromDynamicRate(data?.percentage ?? null);
        } 
        
        //mode statique
        if (!dynamicIrisEnabled && communeMotorizationByCode) {
          return colorFromRate(communeMotorizationByCode.get(codeIris) ?? null);
        }
        
        return [148, 163, 184, 80] as const;
      },
      getLineColor: [20, 24, 39, 180],
      lineWidthMinPixels: 1,
      updateTriggers: {
        getFillColor: [
          dynamicIrisEnabled,
          dynamicIrisEnabled ? (dynamicIrisPresenceByCode ? Array.from(dynamicIrisPresenceByCode.values()) : []) : communeMotorizationByCode
        ],
      },
    });
  }, [dynamicIrisEnabled, dynamicIrisPresenceByCode, communeMotorizationByCode, irisData, irisOpacity]);

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

  const handleMouseLeave = useCallback(() => {
    setIsLeftMouseDown(false);
    setIsHoveringVehicle(false);
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

  const handleMapMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 0) {
      setIsLeftMouseDown(true);
    }

    handleSelectionMouseDown(event);
  }, [handleSelectionMouseDown]);

  const handleMapMouseUp = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 0) {
      setIsLeftMouseDown(false);
    }

    handleSelectionMouseUp(event);
  }, [handleSelectionMouseUp]);

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

  useEffect(() => {
    setViewState(s => ({ ...s, pitch: flat ? 0 : 45 }));

    const map = mapRef.current;
    if (!map?.getStyle || !map?.setLayoutProperty) return;
    const style = map.getStyle();
    if (!style?.layers) return;

    const visibility = flat ? 'none' : 'visible';
    for (const layer of style.layers) {
      if (layer.type === 'fill-extrusion') {
        map.setLayoutProperty(layer.id, 'visibility', visibility);
      }
    }
  }, [flat]);

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
        billboard: false,
        iconAtlas: atlasRef.current,
        iconMapping: ICON_MAPPING,
        getIcon: () => 'car',
        getPosition: (d: Vehicle) => [d.x, d.y, 1.5],

        getSize: (d: Vehicle) => (d.isRespawning ? 0 : d.id === selectedId ? 42 : 28),
        getAngle: (d: Vehicle) => (d.isRespawning ? 0 : -(anglesRef.current.get(d.id) ?? 0) + CAR_ANGLE_OFFSET),
        getColor: (d: Vehicle) =>
          d.isRespawning
            ? ([0, 0, 0, 0] as [number, number, number, number])
            : d.id === selectedId
              ? ([255, 230, 60, 255] as [number, number, number, number])
              : ([255, 255, 255, 220] as [number, number, number, number]),

        parameters: {
          depthTest: true,
          depthWriteEnabled: true,
        },

        updateTriggers: {
          getColor: [selectedId],
          getAngle: vehicles.length,
          getSize: [selectedId],
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
        cursor: isSelectingBbox ? 'crosshair' : isLeftMouseDown ? 'grabbing' : 'grab',
      }}
      onContextMenu={e => e.preventDefault()}
      onMouseDown={handleMapMouseDown}
      onMouseUp={handleMapMouseUp}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleSelectionMouseMove}
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
        <NavigationControl position="top-right" />

        <DeckGL
          viewState={viewState}
          controller={{ dragPan: !isSelectingBbox, dragRotate: !isSelectingBbox }}
          layers={layers}
          onViewStateChange={(e: any) => setViewState(e.viewState)}
          onClick={onDeckClick}
          onHover={(info: any) => {
            const { object, layer, x, y } = info;
            setIsHoveringVehicle(Boolean(object && layer?.id === 'vehicles'));

            if (layer?.id === 'iris-layer' && object) {
              setHoveredIris({ feature: object as IrisFeature, x, y });
            } else {
              setHoveredIris(null);
            }
          }}
          style={{ width: '100%', height: '100%' }}
          getCursor={({ isDragging }: { isDragging: boolean }) =>
            isSelectingBbox
              ? 'crosshair'
              : isDragging || isLeftMouseDown
                ? 'grabbing'
                : isHoveringVehicle
                  ? 'pointer'
                  : 'grab'
          }
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
            left: hintsCenterLeft,
            transform: 'translateX(-50%)',
            transition: 'left 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
            background: 'rgba(15, 23, 42, 0.9)',
            color: '#f8fafc',
            padding: '8px 12px',
            borderRadius: '999px',
            fontSize: '12px',
            zIndex: 35,
            border: '1px solid rgba(148, 163, 184, 0.35)',
          }}
        >
          Cliquer-déplacer sur la carte pour sélectionner une zone
        </div>
      )}

      {!selectedVehicle && vehicles.length > 0 && (
        <div
          className="click-hint"
          style={{
            left: hintsCenterLeft,
            transform: 'translateX(-50%)',
            transition: 'left 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          Clic sur un véhicule pour le sélectionner · Clic sur la carte pour en ajouter un
        </div>
      )}

      {hoveredIris && (
        <div
          style={{
            position: 'absolute',
            zIndex: 1000,
            pointerEvents: 'none',
            left: hoveredIris.x,
            top: hoveredIris.y,
            transform: 'translate(15px, 15px)',
            background: 'rgba(0, 0, 0, 0.85)',
            color: '#fff',
            padding: '12px',
            borderRadius: '6px',
            fontFamily: 'sans-serif',
            boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
          }}
        >
          {(() => {
            const codeIris = extractFeatureCode(hoveredIris.feature);
            if (!codeIris) return null;

            if (dynamicIrisEnabled && dynamicIrisPresenceByCode) {
              const data = dynamicIrisPresenceByCode.get(codeIris);
              if (!data) return <div style={{ fontStyle: 'italic', opacity: 0.8 }}>Zone vide</div>;

              return (
                <>
                  <div style={{ fontWeight: 700, fontSize: '1.6em', marginBottom: '2px', color: '#38bdf8' }}>
                    {data.count} <span style={{ fontSize: '0.6em', fontWeight: 400, color: '#cbd5e1' }}>véhicules</span>
                  </div>
                  <div style={{ fontSize: '0.95em', opacity: 0.9 }}>
                    Soit {formatPercentage(data.percentage)} du trafic total
                  </div>
                </>
              );
            }

            if (!dynamicIrisEnabled && communeMotorizationByCode) {
              const rate = communeMotorizationByCode.get(codeIris) ?? null;
              if (rate === null || Number.isNaN(rate)) {
                return <div style={{ fontStyle: 'italic', opacity: 0.8 }}>Données indisponibles</div>;
              }
              return (
                <>
                  <div style={{ fontWeight: 700, fontSize: '1.6em', marginBottom: '2px', color: '#38bdf8' }}>
                    {formatPercentage(rate)}
                  </div>
                  <div style={{ fontSize: '1.0em', opacity: 0.9 }}>
                    des foyers possèdent au moins une voiture
                  </div>
                </>
              );
            }

            return null;
          })()}
        </div>
      )}

      <div className="map-attribution">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
        &nbsp;· OpenFreeMap
      </div>
    </div>
  );
};