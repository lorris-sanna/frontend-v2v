import './App.css'
import { MapViewer } from './MapViewer'
import { useWebSocket } from './useWebSocket'

function App() {
  const serverUrl = 'ws://localhost:8080'
  const { vehicles, isConnected, error, isPlaying, speed, sendCommand } = useWebSocket(serverUrl)

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
        
        {isConnected && (
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
