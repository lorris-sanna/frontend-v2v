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
  message?: string;
  [key: string]: unknown;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

interface UseWebSocketReturn {
  vehicles: Vehicle[];
  isConnected: boolean;
  error: string | null;
  simulationRunning: boolean;
  simulationPaused: boolean;
  serverMessage: string | null;
  loadState: LoadState;
  loadEventId: number;
  sendCommand: (command: string, value?: unknown) => void;
}

export const useWebSocket = (url: string = 'http://localhost:8080'): UseWebSocketReturn => {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [simulationPaused, setSimulationPaused] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [loadEventId, setLoadEventId] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const sendQueueRef = useRef<Record<string, unknown>[]>([]);

  const ignoreUpdatesRef = useRef(false);
  const socketUrl = url.replace('http://', 'ws://').replace('https://', 'wss://');

  useEffect(() => {
    let closedByUs = false;

    const createSocket = () => {
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        setError(null);
        attemptRef.current = 0;

        // flush queued commands
        while (sendQueueRef.current.length > 0 && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
          const payload = sendQueueRef.current.shift()!;
          socketRef.current.send(JSON.stringify(payload));
        }
      };

      socket.onmessage = (event) => {
      let msg: ServerMessage;

      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === 'update') {
        if (ignoreUpdatesRef.current) {
            return;
          }

        if (Array.isArray(msg.data)) {
          setVehicles(msg.data as Vehicle[]);
        }
        if (typeof msg.simulationRunning === 'boolean') {
          setSimulationRunning(msg.simulationRunning);
        }
        if (typeof msg.simulationPaused === 'boolean') {
          setSimulationPaused(msg.simulationPaused);
        }
      } else if (msg.type === 'info') {
        ignoreUpdatesRef.current = true;
        setServerMessage(typeof msg.message === 'string' ? msg.message : 'Chargement en cours...');
        setLoadState('loading');
        setLoadEventId(prev => prev + 1);
      } else if (msg.type === 'loaded') {
        ignoreUpdatesRef.current = false;
        setServerMessage(null);
        setLoadState('loaded');
        setLoadEventId(prev => prev + 1);
      } else if (msg.type === 'error') {
        ignoreUpdatesRef.current = false;
        setServerMessage(typeof msg.message === 'string' ? msg.message : 'Erreur côté serveur.');
        setLoadState('error');
        setLoadEventId(prev => prev + 1);
      }
    };

      socket.onerror = () => {
        setIsConnected(false);
        setError('Erreur de connexion WebSocket');
      };

      socket.onclose = () => {
        setIsConnected(false);

        if (closedByUs) {
          return;
        }

        // try reconnect with exponential backoff
        attemptRef.current = Math.min(10, attemptRef.current + 1);
        const delay = Math.min(30000, 500 * 2 ** attemptRef.current);

        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }

        // schedule reconnect
        reconnectTimerRef.current = window.setTimeout(() => {
          createSocket();
        }, delay);
      };

      return () => {
        closedByUs = true;
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        socket.close();
        socketRef.current = null;
      };
    };

    // create initial socket
    const cleanup = createSocket();
    // cleanup is the inner return function
    return cleanup as () => void;
  }, [socketUrl]);

  const sendCommand = useCallback((command: string, value?: unknown) => {
    const payload: Record<string, unknown> = value !== undefined ? { command, value } : { command };

    if (command === 'loadOsmContent' || command === 'loadOsmBbox') {
      ignoreUpdatesRef.current = true;
      setVehicles([]);
      setSimulationRunning(false);
      setSimulationPaused(false);
      setServerMessage('Chargement en cours...');
      setLoadState('loading');
    }

    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      // queue the command to be sent when socket reconnects
      sendQueueRef.current.push(payload);
      setError('WebSocket non connecté — commande mise en file d\'attente');
      return;
    }

    socketRef.current.send(JSON.stringify(payload));
  }, []);

  return {
    vehicles,
    isConnected,
    error,
    simulationRunning,
    simulationPaused,
    serverMessage,
    loadState,
    loadEventId,
    sendCommand,
  };
};
