import { useEffect, useState, useCallback, useRef } from 'react';

interface Vehicle {
  id: number;
  x: number;
  y: number;
  angle: number;
  vitesse: number;
}

interface HttpResponse {
  type: string;
  timestamp?: number;
  data?: Vehicle[];
  [key: string]: unknown;
}

interface UseWebSocketReturn {
  vehicles: Vehicle[];
  isConnected: boolean;
  error: string | null;
  serverMessage: string | null;
  loadState: 'idle' | 'loading' | 'loaded' | 'error';
  loadEventId: number;
  sendCommand: (command: string, value?: unknown) => void;
}

export const useWebSocket = (url: string = 'http://localhost:8080'): UseWebSocketReturn => {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [loadEventId, setLoadEventId] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const ignoreUpdatesRef = useRef(false);
  const socketUrl = url.replace('http://', 'ws://').replace('https://', 'wss://');

  const latestVehiclesRef = useRef<Vehicle[] | null>(null);
  const frameRef = useRef<number | null>(null);
  const isCleaningUp = useRef(false);

  //abonnement au flux WebSocket
  useEffect(() => {
    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;
    isCleaningUp.current = false;

    socket.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      if (isCleaningUp.current) return;
      
      const data: HttpResponse = JSON.parse(event.data);

      if (data.type === 'update') {
        if (ignoreUpdatesRef.current) return;

        if (Array.isArray(data.data)) {
          latestVehiclesRef.current = data.data as Vehicle[];
          if (frameRef.current === null) {
            frameRef.current = requestAnimationFrame(() => {
              if (latestVehiclesRef.current && !isCleaningUp.current) {
                setVehicles(latestVehiclesRef.current);
              }
              frameRef.current = null;
            });
          }
        }
      } else if (data.type === 'info') {
        ignoreUpdatesRef.current = true;

        const message = typeof data.message === 'string' ? data.message : 'Chargement en cours...';
        setServerMessage(message);
        setLoadState('loading');
        setLoadEventId((prev) => prev + 1);
      } else if (data.type === 'loaded') {
        ignoreUpdatesRef.current = false;
        setVehicles([]);
        latestVehiclesRef.current = null;

        setServerMessage(null);
        setLoadState('loaded');
        setLoadEventId((prev) => prev + 1);
      } else if (data.type === 'error') {
        ignoreUpdatesRef.current = false;

        const message = typeof data.message === 'string' ? data.message : 'Erreur côté serveur.';
        setServerMessage(message);
        setLoadState('error');
        setLoadEventId((prev) => prev + 1);
      }
    };

    socket.onerror = () => {
      setIsConnected(false);
      setError('Erreur de connexion WebSocket');
    };

    socket.onclose = () => {
      setIsConnected(false);
    };

    return () => {
      isCleaningUp.current = true;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      latestVehiclesRef.current = null;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [socketUrl]);

  //envoi d'une commande au serveur
  const sendCommand = useCallback((command: string, value?: unknown) => {
    const payload: Record<string, unknown> = value !== undefined ? { command, value } : { command };

    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket non connecté');
      return;
    }

    if (command === 'loadOsmContent' || command === 'loadOsmBbox') {
      setVehicles([]);
      latestVehiclesRef.current = null;
      ignoreUpdatesRef.current = true;
    }

    socketRef.current.send(JSON.stringify(payload));
    console.log('Commande envoyée:', payload);
  }, []);

  return { vehicles, isConnected, error, serverMessage, loadState, loadEventId, sendCommand };
};
