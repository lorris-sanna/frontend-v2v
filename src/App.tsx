import './App.css'
import { MapViewer } from './MapViewer'
import { useWebSocket } from './useWebSocket'

function App() {
  const serverUrl = 'ws://localhost:8080'
  const { vehicles, isConnected, error } = useWebSocket(serverUrl)

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-topline">
          <h1>Simulation de voitures</h1>
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
