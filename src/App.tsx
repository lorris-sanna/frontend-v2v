import './App.css'
import { MapViewer } from './MapViewer'
import { useWebSocket } from './useWebSocket'
import { useState, useEffect, useRef } from 'react'
import Papa from 'papaparse'
import JSZip from 'jszip'

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

    let rate: number | null = null

    const numerator = parseNumericValue(row[numeratorColumn])
    const denominator = parseNumericValue(row[denominatorColumn])

    if (numerator !== null && denominator !== null && denominator > 0) {
      rate = (numerator / denominator) * 100
    }

    if (rate !== null && Number.isFinite(rate)) {
      valuesByCode.set(code, rate)
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

type BBox = {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
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

  return !(bbox1.maxLon < padded.minLon || bbox1.minLon > padded.maxLon ||
           bbox1.maxLat < padded.minLat || bbox1.minLat > padded.maxLat)
}

const filterIrisByVehiclesBbox = (allIrisData: IrisGeoJson, vehiclesList: Array<{ x: number; y: number }>): IrisGeoJson => {
  if (vehiclesList.length === 0 || !allIrisData.features) {
    return allIrisData
  }

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

  const vehiclesBbox: BBox = { minLon, maxLon, minLat, maxLat }

  const filteredFeatures = allIrisData.features.filter(feature => {
    if (!feature || typeof feature !== 'object') {
      return false
    }

    const geometry = (feature as Record<string, unknown>).geometry
    const bounds = extractGeometryBounds(geometry as Record<string, unknown>)

    if (!bounds) {
      return false
    }

    if (!bboxesIntersect(bounds, vehiclesBbox)) {
      return false
    }

    return vehiclesList.some(vehicle => pointInGeometry([vehicle.x, vehicle.y], geometry))
  })

  console.log(`IRIS: ${filteredFeatures.length} polygones sur ${allIrisData.features.length} chargés pour la zone des véhicules`)

  return {
    type: 'FeatureCollection',
    features: filteredFeatures,
  }
}

function App() {
  const serverUrl = 'ws://localhost:8080'
  const { vehicles, isConnected, error, isPlaying, speed, serverMessage, loadState, loadEventId, sendCommand } = useWebSocket(serverUrl)
  const [isSelectingZone, setIsSelectingZone] = useState(false)
  const [irisData, setIrisData] = useState<IrisGeoJson | null>(null)
  const [irisMetricsByCode, setIrisMetricsByCode] = useState<Map<string, number> | null>(null)
  const [showIris, setShowIris] = useState(true)
  const [irisOpacity, setIrisOpacity] = useState(0.7)
  const lastFetchedIrisLoadIdRef = useRef<number>(-1)

  const isLoadingGraph = loadState === 'loading'
  const isGraphLoaded = loadState === 'loaded' || (loadState !== 'error' && vehicles.length > 0)

  const loadIrisCsvText = (csvText: string) => {
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
      console.log(`CSV IRIS chargé (${analysis.rowCount} lignes)`)
    } catch (loadError) {
      console.error('Impossible de charger le CSV IRIS', loadError)
      setIrisMetricsByCode(null)
    }
  }

  useEffect(() => {
    if (loadState !== 'loaded' || vehicles.length === 0) {
      return
    }

    if (lastFetchedIrisLoadIdRef.current === loadEventId) {
      return
    }

    lastFetchedIrisLoadIdRef.current = loadEventId

    const vehiclesSnapshot = vehicles.map(vehicle => ({ x: vehicle.x, y: vehicle.y }))

    void (async () => {
      try {
        const geoJsonResponse = await fetch('/iris.geojson')
        if (geoJsonResponse.ok) {
          const geoJsonData = (await geoJsonResponse.json()) as IrisGeoJson
          if (geoJsonData.type === 'FeatureCollection' && Array.isArray(geoJsonData.features)) {
            const filteredIrisData = filterIrisByVehiclesBbox(geoJsonData, vehiclesSnapshot)
            setIrisData(filteredIrisData)
            console.log(`GeoJSON IRIS chargé et filtré automatiquement (${filteredIrisData.features.length} polygones)`) 
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
            loadIrisCsvText(csvText)
            console.log('CSV IRIS chargé automatiquement')
          }
        }
      } catch (error) {
        console.error('Erreur lors du chargement automatique des assets IRIS', error)
      }
    })()
  }, [loadState, loadEventId, vehicles])

  const handleOsmFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    const numberInput = window.prompt('Nombre de voitures à charger', '1000')
    if (numberInput === null) {
      return
    }

    const nbVoitures = Number.parseInt(numberInput, 10)
    if (!Number.isFinite(nbVoitures) || nbVoitures <= 0) {
      window.alert('Merci de saisir un nombre de voitures valide.')
      return
    }

    setIrisData(null)
    setIrisMetricsByCode(null)

    const reader = new FileReader()

    reader.onload = (readerEvent) => {
      const content = readerEvent.target?.result

      if (typeof content === 'string') {
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
  }

  const handleZoneLoad = () => {
    setIrisData(null)
    setIrisMetricsByCode(null)
    setIsSelectingZone(prev => !prev)
  }

  const handleBboxSelected = ({ minLon, minLat, maxLon, maxLat }: BBox) => {
    setIsSelectingZone(false)

    if (minLon >= maxLon || minLat >= maxLat) {
      window.alert('La zone sélectionnée est invalide.')
      return
    }

    const numberInput = window.prompt('Nombre de voitures à charger', '1000')
    if (numberInput === null) {
      return
    }

    const nbVoitures = Number.parseInt(numberInput, 10)
    if (!Number.isFinite(nbVoitures) || nbVoitures <= 0) {
      window.alert('Merci de saisir un nombre de voitures valide.')
      return
    }

    setIrisData(null)
    setIrisMetricsByCode(null)

    sendCommand('loadOsmBbox', {
      bbox: { minLon, minLat, maxLon, maxLat },
      nbVoitures,
    })
  }

  const handlePlay = () => {
    sendCommand('play')
  }

  const handlePause = () => {
    sendCommand('pause')
  }

  const handleSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSpeed = parseFloat(e.target.value)
    sendCommand('setSpeed', newSpeed)
  }

  const handleIrisToggle = () => {
    setShowIris(prev => !prev)
  }

  const handleIrisOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIrisOpacity(parseFloat(e.target.value))
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-topline">
          <h1>Simulation de voitures</h1>
          <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'Connecté' : 'Déconnecté'}
          </span>
        </div>

        <div className="load-actions">
          <label className="btn btn-upload">
            Charger un fichier OSM
            <input
              type="file"
              accept=".osm,.xml"
              onChange={handleOsmFileChange}
              disabled={isLoadingGraph}
              style={{ display: 'none', marginBottom: '50px' }}
            />
          </label>

          <button className="btn" onClick={handleZoneLoad} disabled={isLoadingGraph}>
            {isSelectingZone ? 'Annuler la sélection' : 'Charger une zone'}
          </button>

          {isLoadingGraph && (
            <span className="loading-hint">Chargement...</span>
          )}

          {!isLoadingGraph && serverMessage && (
            <span className={`startup-hint ${loadState === 'error' ? 'error-message' : ''}`}>
              {serverMessage}
            </span>
          )}
        </div>

        {isConnected && isGraphLoaded && !isLoadingGraph && (
          <div className="controls">
            <div className="button-group">
              <button
                className={`btn ${isPlaying ? 'btn-pause' : 'btn-play'}`}
                onClick={isPlaying ? handlePause : handlePlay}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
            </div>

            <div className="speed-control">
              <label htmlFor="speed-slider">Vitesse:</label>
              <input
                id="speed-slider"
                type="range"
                min="0.1"
                max="5"
                step="0.1"
                value={speed}
                onChange={handleSpeedChange}
                className="speed-slider"
              />
              <span className="speed-value">{speed.toFixed(1)}x</span>
            </div>

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
                  <label htmlFor="iris-opacity-slider">Opacité IRIS:</label>
                  <input
                    id="iris-opacity-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={irisOpacity}
                    onChange={handleIrisOpacityChange}
                    className="iris-opacity-slider"
                  />
                  <span className="opacity-value">{Math.round(irisOpacity * 100)}%</span>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="app-main">
        {isConnected ? (
          <MapViewer
            vehicles={vehicles}
            irisData={showIris ? irisData : null}
            communeMotorizationByCode={irisMetricsByCode}
            irisOpacity={irisOpacity}
            initialLongitude={7.5}
            initialLatitude={48.3}
            initialZoom={11}
            isSelectingBbox={isSelectingZone}
            onBboxSelected={handleBboxSelected}
          />
        ) : (
          <div className="loading">
            <p>Connexion en cours</p>
            <p className="url">Serveur: {serverUrl}</p>
            {error && <p className="error">{error}</p>}
          </div>
        )}
      </main>
    </div>
  )
}

export default App
