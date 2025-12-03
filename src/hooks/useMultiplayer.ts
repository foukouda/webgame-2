'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export interface RemotePlayer {
  id: string;
  x: number;
  z: number;
  angle: number;
  health: number;
  flashlightOn: boolean;
  name: string;
}

export interface RemoteProjectile {
  id: string;
  ownerId: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  damage: number;
}

export interface RemoteFireZone {
  id: string;
  x: number;
  z: number;
  radius: number;
  timeLeft: number;
}

export interface ChatMessage {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
}

interface UseMultiplayerReturn {
  connected: boolean;
  playerId: string | null;
  remotePlayers: Map<string, RemotePlayer>;
  remoteProjectiles: RemoteProjectile[];
  remoteFireZones: RemoteFireZone[];
  ringRadius: number;
  ringTimer: number;
  chatMessages: ChatMessage[];
  playerCount: number;
  sendMove: (x: number, z: number, angle: number) => void;
  sendShoot: (projectiles: Array<{ x: number; z: number; vx: number; vz: number; damage: number }>) => void;
  sendMolotov: (x: number, z: number, radius: number) => void;
  sendToggleFlashlight: (on: boolean) => void;
  sendTakeDamage: (amount: number, fromPlayerId?: string) => void;
  sendRespawn: () => void;
  sendChat: (message: string) => void;
}

export function useMultiplayer(serverUrl: string): UseMultiplayerReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map());
  const [remoteProjectiles, setRemoteProjectiles] = useState<RemoteProjectile[]>([]);
  const [remoteFireZones, setRemoteFireZones] = useState<RemoteFireZone[]>([]);
  const [ringRadius, setRingRadius] = useState(80);
  const [ringTimer, setRingTimer] = useState(7 * 60);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  
  // Throttle pour les mises à jour de position
  const lastMoveTime = useRef(0);
  const MOVE_THROTTLE = 50; // 20 updates/seconde max

  useEffect(() => {
    console.log('🔌 Connecting to server:', serverUrl);
    
    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000
    });
    
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('✅ Connected to server!');
      setConnected(true);
    });

    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error.message);
    });

    socket.on('init', (data: { 
      playerId: string; 
      players: RemotePlayer[];
      projectiles: RemoteProjectile[];
      fireZones: RemoteFireZone[];
      ringRadius: number;
      ringTimer: number;
    }) => {
      console.log('🎮 Game initialized, your ID:', data.playerId);
      setPlayerId(data.playerId);
      
      const playerMap = new Map<string, RemotePlayer>();
      data.players.forEach(p => {
        if (p.id !== data.playerId) {
          playerMap.set(p.id, p);
        }
      });
      setRemotePlayers(playerMap);
      setRemoteProjectiles(data.projectiles);
      setRemoteFireZones(data.fireZones);
      setRingRadius(data.ringRadius);
      setRingTimer(data.ringTimer);
    });

    socket.on('playerJoined', (player: RemotePlayer) => {
      console.log('👋 Player joined:', player.id);
      setRemotePlayers(prev => {
        const next = new Map(prev);
        next.set(player.id, player);
        return next;
      });
    });

    socket.on('playerMoved', (data: { id: string; x: number; z: number; angle: number }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev);
        const player = next.get(data.id);
        if (player) {
          player.x = data.x;
          player.z = data.z;
          player.angle = data.angle;
        }
        return next;
      });
    });

    socket.on('playerLeft', (id: string) => {
      console.log('👋 Player left:', id);
      setRemotePlayers(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    });

    socket.on('projectilesFired', (data: { ownerId: string; projectiles: RemoteProjectile[] }) => {
      // Ne pas ajouter nos propres projectiles (on les gère localement)
      if (data.ownerId !== socket.id) {
        setRemoteProjectiles(prev => [...prev, ...data.projectiles]);
      }
    });

    socket.on('projectilesRemoved', (ids: string[]) => {
      setRemoteProjectiles(prev => prev.filter(p => !ids.includes(p.id)));
    });

    socket.on('fireCreated', (fire: RemoteFireZone) => {
      setRemoteFireZones(prev => [...prev, fire]);
    });

    socket.on('fireZonesRemoved', (ids: string[]) => {
      setRemoteFireZones(prev => prev.filter(f => !ids.includes(f.id)));
    });

    socket.on('flashlightToggled', (data: { id: string; on: boolean }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev);
        const player = next.get(data.id);
        if (player) {
          player.flashlightOn = data.on;
        }
        return next;
      });
    });

    socket.on('playerHit', (data: { playerId: string; health: number; projectileId: string; fromPlayerId: string }) => {
      setRemoteProjectiles(prev => prev.filter(p => p.id !== data.projectileId));
      setRemotePlayers(prev => {
        const next = new Map(prev);
        const player = next.get(data.playerId);
        if (player) {
          player.health = data.health;
        }
        return next;
      });
    });

    socket.on('playerDamaged', (data: { id: string; health: number }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev);
        const player = next.get(data.id);
        if (player) {
          player.health = data.health;
        }
        return next;
      });
    });

    socket.on('playerDied', (data: { id: string; killedBy: string }) => {
      console.log(`💀 Player ${data.id} killed by ${data.killedBy}`);
      setRemotePlayers(prev => {
        const next = new Map(prev);
        const player = next.get(data.id);
        if (player) {
          player.health = 0;
        }
        return next;
      });
    });

    socket.on('playerRespawned', (data: { id: string; x: number; z: number; health: number }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev);
        const player = next.get(data.id);
        if (player) {
          player.x = data.x;
          player.z = data.z;
          player.health = data.health;
        }
        return next;
      });
    });

    socket.on('ringUpdate', (data: { radius: number; timer: number }) => {
      setRingRadius(data.radius);
      setRingTimer(data.timer);
    });

    socket.on('ringDamage', (health: number) => {
      // Le composant parent gère les dégâts du ring localement
      window.dispatchEvent(new CustomEvent('ringDamage', { detail: { health } }));
    });

    socket.on('fireDamage', (health: number) => {
      window.dispatchEvent(new CustomEvent('fireDamage', { detail: { health } }));
    });

    socket.on('chatMessage', (data: { playerId: string; playerName: string; message: string }) => {
      setChatMessages(prev => [...prev.slice(-50), { ...data, timestamp: Date.now() }]);
    });

    socket.on('disconnect', () => {
      console.log('❌ Disconnected from server');
      setConnected(false);
    });

    return () => {
      console.log('🔌 Disconnecting...');
      socket.disconnect();
    };
  }, [serverUrl]);

  const sendMove = useCallback((x: number, z: number, angle: number) => {
    const now = Date.now();
    if (now - lastMoveTime.current >= MOVE_THROTTLE) {
      socketRef.current?.emit('move', { x, z, angle });
      lastMoveTime.current = now;
    }
  }, []);

  const sendShoot = useCallback((projectiles: Array<{ x: number; z: number; vx: number; vz: number; damage: number }>) => {
    socketRef.current?.emit('shoot', { projectiles });
  }, []);

  const sendMolotov = useCallback((x: number, z: number, radius: number) => {
    socketRef.current?.emit('molotov', { x, z, radius });
  }, []);

  const sendToggleFlashlight = useCallback((on: boolean) => {
    socketRef.current?.emit('toggleFlashlight', on);
  }, []);

  const sendTakeDamage = useCallback((amount: number, fromPlayerId?: string) => {
    socketRef.current?.emit('takeDamage', { amount, fromPlayerId });
  }, []);

  const sendRespawn = useCallback(() => {
    socketRef.current?.emit('respawn');
  }, []);

  const sendChat = useCallback((message: string) => {
    socketRef.current?.emit('chat', message);
  }, []);

  return {
    connected,
    playerId,
    remotePlayers,
    remoteProjectiles,
    remoteFireZones,
    ringRadius,
    ringTimer,
    chatMessages,
    playerCount: remotePlayers.size + (connected ? 1 : 0),
    sendMove,
    sendShoot,
    sendMolotov,
    sendToggleFlashlight,
    sendTakeDamage,
    sendRespawn,
    sendChat
  };
}
