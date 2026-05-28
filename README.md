# Frontend React

## Installation

```bash
cd frontend-v2v
npm install
```

## Démarrage du frontend

```bash
npm run dev
```

Cela lance Vite sur `http://localhost:5173`

## Données GeoJSON pour les IRIS

Télécharger le fichier `iris.geojson` depuis ce lien :

https://drive.google.com/file/d/1YRy9fpOtaU1Mm5rOa-D0zd8_3oXl-mUU/view?usp=drive_link

Une fois téléchargé :

1. Placer le fichier dans le dossier `frontend-v2v/public/`
2. Renommer le fichier en `iris.geojson` (si nécessaire)

## Architecture

### Composants principaux

1. **App.tsx**
   - Gère la connexion WebSocket
   - Affiche l'état de connexion et les statistiques

2. **MapViewer.tsx**
   - Affiche la carte avec React Map GL
   - Utilise Deck.gl pour le rendu des voitures
   - Permet le zoom et la navigation

3. **useWebSocket.ts**
   - Gère la connexion au serveur C++
   - Analyse les messages JSON

## Configuration

### URL du serveur WebSocket

Par défaut: `ws://localhost:8080`

## Format des données

### Exemple de messages du serveur

```json
{
  "type": "update",
  "timestamp": 1234567890,
  "data": [
    {"id": 0, "x": 120.5, "y": 450.2, "angle": 45, "vitesse": 50},
    {"id": 1, "x": 125.0, "y": 448.0, "angle": 90, "vitesse": 55}
  ]
}
```