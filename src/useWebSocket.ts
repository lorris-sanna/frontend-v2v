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
  sendCommand: (command: string, value?: unknown) => void;
}

export const useWebSocket = (url: string = 'http://localhost:8080'): UseWebSocketReturn => {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const socketUrl = url.replace('http://', 'ws://').replace('https://', 'wss://');

  // S'abonner au flux WebSocket
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
          setVehicles(data.data as Vehicle[]);
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
      socket.close();
      socketRef.current = null;
    };
  }, [socketUrl]);

  // Envoyer une commande au serveur
  const sendCommand = useCallback((command: string, value?: unknown) => {
    const payload: Record<string, unknown> = value !== undefined ? { command, value } : { command };

    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket non connecté');
      return;
    }

    socketRef.current.send(JSON.stringify(payload));
    console.log('Commande envoyée:', payload);
  }, []);

  return { vehicles, isConnected, error, sendCommand };
};
