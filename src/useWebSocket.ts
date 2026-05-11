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
  isRunning?: boolean;
  speedFactor?: number;
  [key: string]: unknown;
}

interface UseWebSocketReturn {
  vehicles: Vehicle[];
  isConnected: boolean;
  error: string | null;
  isPlaying: boolean;
  speed: number;
  sendCommand: (command: string, value?: unknown) => void;
}

export const useWebSocket = (url: string = 'http://localhost:8080'): UseWebSocketReturn => {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const socketRef = useRef<WebSocket | null>(null);
  const socketUrl = url.replace('http://', 'ws://').replace('https://', 'wss://');

  const latestVehiclesRef = useRef<Vehicle[] | null>(null);
  const frameRef = useRef<number | null>(null);

  //abonnement au flux WebSocket
  useEffect(() => {
    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      const data: HttpResponse = JSON.parse(event.data);

      if (data.type === 'update') {
        if (Array.isArray(data.data)) {
          latestVehiclesRef.current = data.data as Vehicle[];
          if (frameRef.current === null) {
            frameRef.current = requestAnimationFrame(() => {
              if (latestVehiclesRef.current) {
                setVehicles(latestVehiclesRef.current);
              }
              frameRef.current = null;
            });
          }
        }
      } else if (data.type === 'status') {
        if (data.isRunning !== undefined) {
          setIsPlaying(data.isRunning);
        }
        if (data.speedFactor !== undefined) {
          setSpeed(data.speedFactor);
        }
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
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      socket.close();
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

    socketRef.current.send(JSON.stringify(payload));
    console.log('Commande envoyée:', payload);
  }, []);

  return { vehicles, isConnected, error, isPlaying, speed, sendCommand };
};
