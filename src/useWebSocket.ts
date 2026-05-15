import { useEffect, useState, useCallback, useRef } from 'react';

interface Vehicle {
  id: number;
  x: number;
  y: number;
  angle: number;
  vitesse: number;
}

interface ServerMessage {
  type: string;
  timestamp?: number;
  data?: Vehicle[];
  simulationRunning?: boolean;
  simulationPaused?: boolean;
  [key: string]: unknown;
}

interface UseWebSocketReturn {
  vehicles: Vehicle[];
  isConnected: boolean;
  error: string | null;
  simulationRunning: boolean;
  simulationPaused: boolean;
  sendCommand: (command: string, value?: unknown) => void;
}

export const useWebSocket = (url: string = 'http://localhost:8080'): UseWebSocketReturn => {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [simulationPaused, setSimulationPaused] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const socketUrl = url.replace('http://', 'ws://').replace('https://', 'wss://');

  useEffect(() => {
    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);

      if (msg.type === 'update') {
        if (Array.isArray(msg.data)) {
          setVehicles(msg.data as Vehicle[]);
        }
        if (typeof msg.simulationRunning === 'boolean') {
          setSimulationRunning(msg.simulationRunning);
        }
        if (typeof msg.simulationPaused === 'boolean') {
          setSimulationPaused(msg.simulationPaused);
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

  const sendCommand = useCallback((command: string, value?: unknown) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket non connecté');
      return;
    }
    const payload: Record<string, unknown> =
      value !== undefined ? { command, value } : { command };
    socketRef.current.send(JSON.stringify(payload));
  }, []);

  return { vehicles, isConnected, error, simulationRunning, simulationPaused, sendCommand };
};
