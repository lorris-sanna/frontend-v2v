import './App.css'
import { MapViewer } from './MapViewer'
import { useWebSocket } from './useWebSocket'
import { useEffect, useState } from 'react'

type BBox = {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

function App() {
  const serverUrl = 'ws://localhost:8080'
  const { vehicles, isConnected, error, isPlaying, speed, serverMessage, loadState, loadEventId, sendCommand } = useWebSocket(serverUrl)
  const [isGraphLoaded, setIsGraphLoaded] = useState(false)
  const [isLoadingGraph, setIsLoadingGraph] = useState(false)
  const [isSelectingZone, setIsSelectingZone] = useState(false)

  useEffect(() => {
    if (loadState === 'loading') {
      setIsLoadingGraph(true)
      setIsGraphLoaded(false)
    } else if (loadState === 'loaded') {
      setIsLoadingGraph(false)
      setIsGraphLoaded(true)
    } else if (loadState === 'error') {
      setIsLoadingGraph(false)
      setIsGraphLoaded(false)
    }
  }, [loadState, loadEventId])

  useEffect(() => {
    if (loadState !== 'loading' && vehicles.length > 0) {
      setIsLoadingGraph(false)
      setIsGraphLoaded(true)
    }
  }, [vehicles.length, loadState])

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

    const reader = new FileReader()

    reader.onload = (readerEvent) => {
      const content = readerEvent.target?.result

      if (typeof content === 'string') {
        setIsLoadingGraph(true)
        setIsGraphLoaded(false)
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

    sendCommand('loadOsmBbox', {
      bbox: { minLon, minLat, maxLon, maxLat },
      nbVoitures,
    })
    setIsLoadingGraph(true)
    setIsGraphLoaded(false)
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
          </div>
        )}
      </header>

      <main className="app-main">
        {isConnected ? (
          <MapViewer 
            vehicles={vehicles}
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
