import { useState, useCallback, useEffect, useRef } from 'react'
import './App.css'
import { MapViewer } from './MapViewer'
import { useWebSocket } from './useWebSocket'
import Papa from 'papaparse'
import JSZip from 'jszip'

const SPEED_MIN = 0.25
const SPEED_MAX = 5
const SPEED_STEP = 0.25
const SPEED_DEFAULT = 1

const VEHICLE_MIN = 100
const VEHICLE_MAX = 10000
const VEHICLE_STEP = 100
const VEHICLE_DEFAULT = 10000
const SIDE_MENU_WIDTH = 350

type IrisGeoJson = {
  type: 'FeatureCollection'
  features: Array<Record<string, unknown>>
}

type IrisCsvAnalysis = {
  valuesByCode: Map<string, number>
  codeColumn: string
  numeratorColumn: string | null
  denominatorColumn: string | null
  rowCount: number
}

type BBox = {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

function formatSpeed(s: number): string {
  return `${parseFloat(s.toFixed(2))}×`
}

function formatVehicleCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`
}

function clampVehicleCount(n: number): number {
  return Math.min(VEHICLE_MAX, Math.max(VEHICLE_MIN, n))
}

const normalizeText = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

const parseNumericValue = (value: unknown) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalized = value
    .replace(/[\s\u00A0\u202F']/g, '')
    .replace(',', '.')
    .trim()

  if (normalized === '') {
    return null
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

const findColumn = (rows: Record<string, unknown>[], predicates: Array<(column: string) => boolean>) => {
  const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row))))

  return columns.find(column => predicates.some(predicate => predicate(column))) ?? null
}

const buildIrisMotorizationMap = (rows: Record<string, unknown>[]): IrisCsvAnalysis => {
  const codeColumn = findColumn(rows, [
    column => ['iris', 'code_iris'].includes(normalizeText(column)),
    column => normalizeText(column).includes('iris'),
    column => normalizeText(column).includes('code') && normalizeText(column).includes('iris'),
  ])

  const numeratorColumn = findColumn(rows, [
    column => column === 'P22_RP_VOIT1P',
    column => column === 'P21_RP_VOIT1P',
    column => normalizeText(column) === 'p22_rp_voit1p',
    column => normalizeText(column) === 'p21_rp_voit1p',
  ])

  const denominatorColumn = findColumn(rows, [
    column => column === 'P22_MEN',
    column => column === 'P21_MEN',
    column => normalizeText(column) === 'p22_men',
    column => normalizeText(column) === 'p21_men',
  ])

  if (!codeColumn) {
    throw new Error('Aucune colonne IRIS n\'a été trouvée dans le CSV.')
  }

  if (!numeratorColumn || !denominatorColumn) {
    throw new Error('Les colonnes P21_RP_VOIT1P et P21_MEN sont requises pour calculer la motorisation.')
  }

  const valuesByCode = new Map<string, number>()

  for (const row of rows) {
    const rawCode = row[codeColumn]
    const code = String(rawCode ?? '').trim()

    if (!code) {
      continue
    }

    const numerator = parseNumericValue(row[numeratorColumn])
    const denominator = parseNumericValue(row[denominatorColumn])

    if (numerator !== null && denominator !== null && denominator > 0) {
      const rate = (numerator / denominator) * 100

      if (Number.isFinite(rate)) {
        valuesByCode.set(code, rate)
      }
    }
  }

  if (valuesByCode.size === 0) {
    throw new Error('Aucune valeur de motorisation exploitable n\'a été trouvée dans le CSV IRIS.')
  }

  return {
    valuesByCode,
    codeColumn,
    numeratorColumn,
    denominatorColumn,
    rowCount: rows.length,
  }
}

const extractGeometryBounds = (geometry: Record<string, unknown>): BBox | null => {
  if (!geometry || typeof geometry !== 'object') {
    return null
  }

  const type = (geometry as Record<string, unknown>).type
  const coords = (geometry as Record<string, unknown>).coordinates

  if (!type || !Array.isArray(coords)) {
    return null
  }

  const allCoords: Array<[number, number]> = []

  const flattenCoords = (arr: unknown): void => {
    if (!Array.isArray(arr)) {
      return
    }

    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      allCoords.push([arr[0] as number, arr[1] as number])
    } else {
      for (const item of arr) {
        flattenCoords(item)
      }
    }
  }

  flattenCoords(coords)

  if (allCoords.length === 0) {
    return null
  }

  let minLon = allCoords[0][0]
  let maxLon = allCoords[0][0]
  let minLat = allCoords[0][1]
  let maxLat = allCoords[0][1]

  for (const [lon, lat] of allCoords) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }

  return { minLon, maxLon, minLat, maxLat }
}

const pointInRing = (point: [number, number], ring: unknown): boolean => {
  if (!Array.isArray(ring)) {
    return false
  }

  let inside = false
  const [x, y] = point

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index]
    const previousPoint = ring[previous]

    if (
      !Array.isArray(currentPoint) ||
      !Array.isArray(previousPoint) ||
      typeof currentPoint[0] !== 'number' ||
      typeof currentPoint[1] !== 'number' ||
      typeof previousPoint[0] !== 'number' ||
      typeof previousPoint[1] !== 'number'
    ) {
      continue
    }

    const currentX = currentPoint[0]
    const currentY = currentPoint[1]
    const previousX = previousPoint[0]
    const previousY = previousPoint[1]

    const intersects =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX

    if (intersects) {
      inside = !inside
    }
  }

  return inside
}

const pointInPolygon = (point: [number, number], polygon: unknown): boolean => {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    return false
  }

  if (!pointInRing(point, polygon[0])) {
    return false
  }

  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(point, polygon[index])) {
      return false
    }
  }

  return true
}

const pointInGeometry = (point: [number, number], geometry: unknown): boolean => {
  if (!geometry || typeof geometry !== 'object') {
    return false
  }

  const typedGeometry = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  const type = String(typedGeometry.type ?? '').trim()

  if (type === 'Polygon') {
    return pointInPolygon(point, typedGeometry.coordinates)
  }

  if (type === 'MultiPolygon' && Array.isArray(typedGeometry.coordinates)) {
    return typedGeometry.coordinates.some(polygon => pointInPolygon(point, polygon))
  }

  if (type === 'GeometryCollection' && Array.isArray(typedGeometry.geometries)) {
    return typedGeometry.geometries.some(subGeometry => pointInGeometry(point, subGeometry))
  }

  return false
}

const bboxesIntersect = (bbox1: BBox, bbox2: BBox, padding = 0.01): boolean => {
  const padded = {
    minLon: bbox2.minLon - padding,
    maxLon: bbox2.maxLon + padding,
    minLat: bbox2.minLat - padding,
    maxLat: bbox2.maxLat + padding,
  }

  return !(
    bbox1.maxLon < padded.minLon ||
    bbox1.minLon > padded.maxLon ||
    bbox1.maxLat < padded.minLat ||
    bbox1.minLat > padded.maxLat
  )
}

const filterIrisByGraphBbox = (
  allIrisData: IrisGeoJson,
  graphBbox: BBox | null,
  vehiclesList: Array<{ x: number; y: number }>
): IrisGeoJson => {
  if (!allIrisData.features) return allIrisData

  let bboxToUse: BBox | null = graphBbox

  if (!bboxToUse) {
    if (vehiclesList.length === 0) return allIrisData

    let minLon = vehiclesList[0].x
    let maxLon = vehiclesList[0].x
    let minLat = vehiclesList[0].y
    let maxLat = vehiclesList[0].y

    for (const vehicle of vehiclesList) {
      if (vehicle.x < minLon) minLon = vehicle.x
      if (vehicle.x > maxLon) maxLon = vehicle.x
      if (vehicle.y < minLat) minLat = vehicle.y
      if (vehicle.y > maxLat) maxLat = vehicle.y
    }

    bboxToUse = { minLon, maxLon, minLat, maxLat }
  }

  const filteredFeatures = allIrisData.features.filter(feature => {
    if (!feature || typeof feature !== 'object') return false

    const geometry = (feature as Record<string, unknown>).geometry
    const bounds = extractGeometryBounds(geometry as Record<string, unknown>)

    if (!bounds) return false

    const graphBB = bboxToUse as BBox

    const centerLon = (bounds.minLon + bounds.maxLon) / 2
    const centerLat = (bounds.minLat + bounds.maxLat) / 2

    return (
      centerLon >= graphBB.minLon &&
      centerLon <= graphBB.maxLon &&
      centerLat >= graphBB.minLat &&
      centerLat <= graphBB.maxLat
    )
  })

  return {
    type: 'FeatureCollection',
    features: filteredFeatures,
  }
}

function App() {
  const serverUrl = 'ws://localhost:8080'
  const {
    vehicles,
    isConnected,
    error,
    simulationRunning,
    simulationPaused,
    serverMessage,
    loadState,
    loadEventId,
    sendCommand,
  } =
    useWebSocket(serverUrl)

  const [speed, setSpeed] = useState<number>(SPEED_DEFAULT)
  const [vehicleCount, setVehicleCount] = useState<number>(() => {
    const saved = localStorage.getItem('vehicleCount')
    if (saved !== null) {
      const parsed = parseInt(saved, 10)
      if (Number.isFinite(parsed)) return clampVehicleCount(parsed)
    }
    return VEHICLE_DEFAULT
  })
  const [isSelectingZone, setIsSelectingZone] = useState(false)
  const [irisData, setIrisData] = useState<IrisGeoJson | null>(null)
  const [irisMetricsByCode, setIrisMetricsByCode] = useState<Map<string, number> | null>(null)
  const [showIris, setShowIris] = useState(true)
  const [graphBBox, setGraphBBox] = useState<BBox | null>(null)
  const [irisOpacity, setIrisOpacity] = useState(0.5)
  const [sideMenuOpen, setSideMenuOpen] = useState(true)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const lastFetchedIrisLoadIdRef = useRef<number>(-1)
  const lastAutostartLoadIdRef = useRef<number>(-1)

  const isLoadingGraph = loadState === 'loading'
  const isGraphLoaded = loadState === 'loaded' || (loadState !== 'error' && vehicles.length > 0)

  const loadIrisCsvText = useCallback((csvText: string) => {
    try {
      const parsed = Papa.parse<Record<string, unknown>>(csvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        delimitersToGuess: [';', ',', '\t', '|'],
      })

      if (parsed.errors.length > 0) {
        throw new Error(parsed.errors[0]?.message || 'Impossible de parser le CSV.')
      }

      const rows = parsed.data.filter(row => row && Object.keys(row).length > 0)
      const analysis = buildIrisMotorizationMap(rows)

      setIrisMetricsByCode(analysis.valuesByCode)
    } catch (loadError) {
      console.error('Impossible de charger le CSV IRIS', loadError)
      setIrisMetricsByCode(null)
    }
  }, [])

  useEffect(() => {
    if (!isGraphLoaded || vehicles.length === 0 || !simulationRunning) {
      return
    }

    if (lastFetchedIrisLoadIdRef.current === loadEventId) {
    return
  }

  lastFetchedIrisLoadIdRef.current = loadEventId
  const currentLoadId = loadEventId

  const vehiclesSnapshot = vehicles.map(vehicle => ({ x: vehicle.x, y: vehicle.y }))

  void (async () => {
    try {
      const geoJsonResponse = await fetch('/iris.geojson')

      if (geoJsonResponse.ok) {
        const geoJsonData = (await geoJsonResponse.json()) as IrisGeoJson

        if (geoJsonData.type === 'FeatureCollection' && Array.isArray(geoJsonData.features)) {
          const filteredIrisData = filterIrisByGraphBbox(geoJsonData, graphBBox, vehiclesSnapshot)

          if (lastFetchedIrisLoadIdRef.current === currentLoadId) {
            setIrisData(filteredIrisData)
          }
        }
      }

      const zipResponse = await fetch('/base-ic-logement-2022_csv.zip')

      if (zipResponse.ok) {
        const zipBuffer = await zipResponse.arrayBuffer()
        const archive = await JSZip.loadAsync(zipBuffer)
        const csvEntry = Object.values(archive.files).find(
          entry => !entry.dir && entry.name.toLowerCase().endsWith('.csv')
        )

        if (csvEntry) {
          const csvText = await csvEntry.async('string')
          
          if (lastFetchedIrisLoadIdRef.current === currentLoadId) {
            loadIrisCsvText(csvText)
          }
        }
      }
    } catch (loadError) {
      console.error('Erreur lors du chargement automatique des assets IRIS', loadError)
      if (lastFetchedIrisLoadIdRef.current === currentLoadId) {
        setIrisData(null)
        setIrisMetricsByCode(null)
      }
    }
  })()
}, [isGraphLoaded, loadEventId, loadIrisCsvText, vehicles, simulationRunning, graphBBox])

  useEffect(() => {
    if (!isGraphLoaded || simulationRunning) {
      return
    }

    if (lastAutostartLoadIdRef.current === loadEventId) {
      return
    }

    lastAutostartLoadIdRef.current = loadEventId
    sendCommand('start')
  }, [isGraphLoaded, loadEventId, simulationRunning, vehicles.length, sendCommand])

  const handlePauseResume = useCallback(() => {
    if (!simulationRunning) {
      sendCommand('start')
      return
    }

    sendCommand('pause')
  }, [sendCommand, simulationRunning])

  const handleSpeedSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const s = parseFloat(e.target.value)
    setSpeed(s)
    sendCommand('speed', s)
  }, [sendCommand])

  const handleVehicleSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setVehicleCount(parseInt(e.target.value))
  }, [])

  const commitVehicleCount = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    const val = clampVehicleCount(parseInt((e.target as HTMLInputElement).value, 10))
    setVehicleCount(val)
    localStorage.setItem('vehicleCount', String(val))
    sendCommand('setVehicles', val)
  }, [sendCommand])

  const handleFileButtonClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleOsmFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    const numberInput = window.prompt('Nombre de voitures à charger', '1000')
    if (numberInput === null) {
      return
    }

    const rawVehicleCount = Number.parseInt(numberInput, 10)
    const nbVoitures = clampVehicleCount(rawVehicleCount)
    if (!Number.isFinite(rawVehicleCount) || rawVehicleCount <= 0) {
      window.alert('Merci de saisir un nombre de voitures valide.')
      return
    }

    setVehicleCount(nbVoitures)
    localStorage.setItem('vehicleCount', String(nbVoitures))

    setIsSelectingZone(false)
    setIrisData(null)
    setIrisMetricsByCode(null)

    const reader = new FileReader()

    reader.onload = (readerEvent) => {
      const content = readerEvent.target?.result

      if (typeof content === 'string') {
        try {
          const xml = content
          const nodeTagRe = /<node\b([^>]*)>/g
          let m: RegExpExecArray | null
          let found = false
          let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity

          while ((m = nodeTagRe.exec(xml)) !== null) {
            const attrs = m[1]
            const latMatch = attrs.match(/lat="([^"]+)"/)
            const lonMatch = attrs.match(/lon="([^"]+)"/)

            if (latMatch && lonMatch) {
              const lat = Number.parseFloat(latMatch[1])
              const lon = Number.parseFloat(lonMatch[1])
              if (Number.isFinite(lat) && Number.isFinite(lon)) {
                found = true
                if (lon < minLon) minLon = lon
                if (lon > maxLon) maxLon = lon
                if (lat < minLat) minLat = lat
                if (lat > maxLat) maxLat = lat
              }
            }
          }

          if (found) {
            setGraphBBox({ minLon, minLat, maxLon, maxLat })
          } else {
            setGraphBBox(null)
          }
        } catch (e) {
          setGraphBBox(null)
        }

        sendCommand('loadOsmContent', {
          osmContent: content,
          nbVoitures,
        })
      }
    }

    reader.onerror = () => {
      console.error('Impossible de lire le fichier OSM sélectionné')
    }

    reader.readAsText(file)
  }, [sendCommand])

  const handleZoneLoad = useCallback(() => {
    setIsSelectingZone(prev => !prev)
  }, [])

  const handleBboxSelected = useCallback(({ minLon, minLat, maxLon, maxLat }: BBox) => {
    setIsSelectingZone(false)

    if (minLon >= maxLon || minLat >= maxLat) {
      window.alert('La zone sélectionnée est invalide.')
      return
    }

    const numberInput = window.prompt('Nombre de voitures à charger', '1000')
    if (numberInput === null) {
      return
    }

    const rawVehicleCount = Number.parseInt(numberInput, 10)
    const nbVoitures = clampVehicleCount(rawVehicleCount)
    if (!Number.isFinite(rawVehicleCount) || rawVehicleCount <= 0) {
      window.alert('Merci de saisir un nombre de voitures valide.')
      return
    }

    setVehicleCount(nbVoitures)
    localStorage.setItem('vehicleCount', String(nbVoitures))

    setIrisData(null)
    setIrisMetricsByCode(null)

    setGraphBBox({ minLon, minLat, maxLon, maxLat })

    sendCommand('loadOsmBbox', {
      bbox: { minLon, minLat, maxLon, maxLat },
      nbVoitures,
    })
  }, [sendCommand])

  const handleIrisToggle = useCallback(() => {
    setShowIris(prev => !prev)
  }, [])

  const handleIrisOpacityChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setIrisOpacity(parseFloat(event.target.value))
  }, [])

  const isActive = simulationRunning && !simulationPaused
  const pauseButtonIsPaused = !simulationRunning || simulationPaused
  const pauseButtonLabel = !simulationRunning ? 'Lancer' : simulationPaused ? 'Reprendre' : 'Pause'
  const pauseButtonTitle = !simulationRunning ? 'Lancer la simulation' : simulationPaused ? 'Reprendre' : 'Mettre en pause'

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-topline">
          <h1>Simulation V2V</h1>
          <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'Connecté' : 'Déconnecté'}
          </span>
        </div>
      </header>

      <main className="app-main">
        {isConnected && (
          <div className="side-menu-container">
            <aside className={`side-menu ${sideMenuOpen ? 'open' : 'closed'}`}>
              <div className="side-menu-content">
              {/* Section chargement du graphe routier */}

              <div className="menu-section">
                <div className="menu-section-title">Chargement du graphe routier</div>
                
                <div className="load-actions">
                  <button className="btn btn-upload" onClick={handleFileButtonClick} disabled={isLoadingGraph}>
                    Charger par fichier
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".osm,.xml"
                    onChange={handleOsmFileChange}
                    style={{ display: 'none' }}
                  />

                  <button className="btn btn-iris" onClick={handleZoneLoad} disabled={isLoadingGraph}>
                    {isSelectingZone ? 'Annuler' : 'Charger par zone'}
                  </button>

                  {isLoadingGraph && <span className="loading-hint">Chargement...</span>}

                  {!isLoadingGraph && serverMessage && (
                    <span className={`startup-hint ${loadState === 'error' ? 'error-message' : ''}`}>
                      {serverMessage}
                    </span>
                  )}
                </div>
              </div>

              {/* Section gestion de la simulation */}
              <div className="menu-section">
                <div className="menu-section-header">
                  <div className="menu-section-title">Simulation</div>
                  <div className={`sim-state-badge${isActive ? ' running' : simulationPaused ? ' paused' : ''}`}>
                    <span className="sim-state-dot" />
                    {isActive ? 'En cours' : simulationPaused ? 'En pause' : '—'}
                  </div>
                </div>
                
                <div className="menu-simulation-controls">
                  <button
                    className={`ctrl-btn ctrl-playpause${pauseButtonIsPaused ? ' paused' : ''}`}
                    onClick={handlePauseResume}
                    title={pauseButtonTitle}
                  >
                    <span
                      className={`ctrl-playpause-icon${pauseButtonIsPaused ? ' ctrl-playpause-icon--play' : ' ctrl-playpause-icon--pause'}`}
                      aria-hidden="true"
                    >
                      {pauseButtonIsPaused ? '▶' : '⏸'}
                    </span>
                    <span className="ctrl-playpause-label">{pauseButtonLabel}</span>
                  </button>

                  <div className="ctrl-speed-group">
                    <span className="ctrl-speed-label">Vitesse</span>
                    <span className="ctrl-vehicles-count">{formatSpeed(speed)}</span>
                    <input
                      type="range"
                      className="ctrl-vehicles-slider"
                      min={SPEED_MIN}
                      max={SPEED_MAX}
                      step={SPEED_STEP}
                      value={speed}
                      style={{ '--pct': `${((speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100).toFixed(1)}` } as React.CSSProperties}
                      onChange={handleSpeedSlider}
                    />
                  </div>

                  <div className="ctrl-vehicles-group">
                    <span className="ctrl-speed-label">Véhicules</span>
                    <span className="ctrl-vehicles-count">{formatVehicleCount(vehicleCount)}</span>
                    <input
                      type="range"
                      className="ctrl-vehicles-slider"
                      min={VEHICLE_MIN}
                      max={VEHICLE_MAX}
                      step={VEHICLE_STEP}
                      value={vehicleCount}
                      style={{ '--pct': `${((vehicleCount - VEHICLE_MIN) / (VEHICLE_MAX - VEHICLE_MIN) * 100).toFixed(1)}` } as React.CSSProperties}
                      onChange={handleVehicleSlider}
                      onPointerUp={commitVehicleCount}
                    />
                  </div>
                </div>
              </div>

              {/* Section gestion des IRIS */}
              <div className="menu-section">
                <div className="menu-section-title">IRIS</div>
                
                <div className="iris-controls">
                  <label htmlFor="iris-toggle" className="iris-checkbox-label">
                    <input
                      id="iris-toggle"
                      type="checkbox"
                      checked={showIris}
                      onChange={handleIrisToggle}
                      className="iris-checkbox"
                    />
                    Afficher les IRIS
                  </label>

                  {showIris && (
                    <div className="iris-opacity-control">
                      <label htmlFor="iris-opacity-slider">Opacité:</label>
                      <input
                        id="iris-opacity-slider"
                        type="range"
                        min="0"
                        max="1"
                        step="0.1"
                        value={irisOpacity}
                        onChange={handleIrisOpacityChange}
                        className="iris-opacity-slider"
                        style={{ '--pct': Math.round(irisOpacity * 100) } as React.CSSProperties}
                      />
                      <span className="opacity-value">{Math.round(irisOpacity * 100)}%</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            </aside>
          </div>
        )}

        {isConnected ? (
          <div className="map-wrapper">
            <MapViewer
              vehicles={vehicles}
              irisData={showIris ? irisData : null}
              communeMotorizationByCode={irisMetricsByCode}
              irisOpacity={irisOpacity}
              sidebarVisibleWidth={sideMenuOpen ? SIDE_MENU_WIDTH : 0}
              initialLongitude={7.5}
              initialLatitude={48.3}
              initialZoom={11}
              onAddVehicle={(lon, lat) => {
                sendCommand('addVehicle', { lon, lat })
                setVehicleCount(prev => {
                  const next = prev + 1
                  localStorage.setItem('vehicleCount', String(next))
                  return next
                })
              }}
              onRemoveVehicle={(id) => {
                sendCommand('removeVehicle', id)
                setVehicleCount(prev => {
                  const next = Math.max(0, prev - 1)
                  localStorage.setItem('vehicleCount', String(next))
                  return next
                })
              }}
              isSelectingBbox={isSelectingZone}
              onBboxSelected={handleBboxSelected}
            />
            <button
              className={`side-menu-toggle ${sideMenuOpen ? 'open' : 'closed'}`}
              onClick={() => setSideMenuOpen(!sideMenuOpen)}
              title={sideMenuOpen ? 'Fermer le panneau' : 'Ouvrir le panneau'}
            >
              <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        ) : (
          <div className="loading">
            <p>Connexion en cours…</p>
            <p className="url">Serveur : {serverUrl}</p>
            {error && <p className="error">{error}</p>}
          </div>
        )}
      </main>
    </div>
  )
}

export default App