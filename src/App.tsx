import { useState, useCallback } from 'react'
import './App.css'
import { MapViewer } from './MapViewer'
import { useWebSocket } from './useWebSocket'

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 5] as const
const VEHICLE_MIN = 100
const VEHICLE_MAX = 10000
const VEHICLE_STEP = 100
const VEHICLE_DEFAULT = 10000

function formatVehicleCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`
}

function App() {
  const serverUrl = 'ws://localhost:8080'
  const { vehicles, isConnected, error, simulationRunning, simulationPaused, sendCommand } =
    useWebSocket(serverUrl)

  const [speed, setSpeed] = useState<number>(1)
  const [vehicleCount, setVehicleCount] = useState<number>(VEHICLE_DEFAULT)

  const handlePauseResume = useCallback(() => {
    sendCommand('pause')
  }, [sendCommand])

  const handleSpeed = useCallback((s: number) => {
    setSpeed(s)
    sendCommand('speed', s)
  }, [sendCommand])

  const handleVehicleSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setVehicleCount(parseInt(e.target.value))
  }, [])

  const commitVehicleCount = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    const val = parseInt((e.target as HTMLInputElement).value)
    sendCommand('setVehicles', val)
  }, [sendCommand])

  const isActive = simulationRunning && !simulationPaused

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-topline">
          <h1>Simulation V2V</h1>

          {/* Contrôles de simulation */}
          {isConnected && (
            <div className="sim-controls">
              {/* Pause / Resume */}
              <button
                className={`ctrl-btn ctrl-playpause${simulationPaused ? ' paused' : ''}`}
                onClick={handlePauseResume}
                title={simulationPaused ? 'Reprendre' : 'Mettre en pause'}
              >
                {simulationPaused ? '▶' : '⏸'}
                <span>{simulationPaused ? 'Reprendre' : 'Pause'}</span>
              </button>

              {/* Séparateur */}
              <div className="ctrl-sep" />

              {/* Vitesse */}
              <div className="ctrl-speed-group">
                <span className="ctrl-speed-label">Vitesse</span>
                <div className="ctrl-speed-btns">
                  {SPEED_PRESETS.map(s => (
                    <button
                      key={s}
                      className={`ctrl-speed-btn${speed === s ? ' active' : ''}`}
                      onClick={() => handleSpeed(s)}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>

              {/* Séparateur */}
              <div className="ctrl-sep" />

              {/* Nombre de véhicules */}
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

              {/* Indicateur d'état */}
              <div className={`sim-state-badge${isActive ? ' running' : simulationPaused ? ' paused' : ''}`}>
                <span className="sim-state-dot" />
                {isActive ? 'En cours' : simulationPaused ? 'En pause' : '—'}
              </div>
            </div>
          )}

          <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'Connecté' : 'Déconnecté'}
          </span>
        </div>
      </header>

      <main className="app-main">
        {isConnected ? (
          <MapViewer
            vehicles={vehicles}
            initialLongitude={7.5}
            initialLatitude={48.3}
            initialZoom={11}
          />
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
