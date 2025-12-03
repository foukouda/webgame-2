'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { RemotePlayer, RemoteProjectile, RemoteFireZone } from '../hooks/useMultiplayer';

interface RemotePlayersProps {
  players: Map<string, RemotePlayer>;
  visionData: {
    playerX: number;
    playerZ: number;
    raycastPoints: Array<{ x: number; z: number }>;
  };
}

// Composant pour un joueur distant
function RemotePlayerMesh({ player, isVisible }: { player: RemotePlayer; isVisible: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const spotLightRef = useRef<THREE.SpotLight>(null);
  const targetRef = useRef<THREE.Object3D>(new THREE.Object3D());
  
  // Interpolation de position pour un mouvement fluide
  const targetPosition = useRef({ x: player.x, z: player.z });
  const currentPosition = useRef({ x: player.x, z: player.z });
  
  useFrame((state, delta) => {
    if (!groupRef.current) return;
    
    // Mettre à jour la position cible
    targetPosition.current.x = player.x;
    targetPosition.current.z = player.z;
    
    // Interpolation fluide (lerp)
    const lerpFactor = Math.min(1, delta * 10);
    currentPosition.current.x += (targetPosition.current.x - currentPosition.current.x) * lerpFactor;
    currentPosition.current.z += (targetPosition.current.z - currentPosition.current.z) * lerpFactor;
    
    groupRef.current.position.x = currentPosition.current.x;
    groupRef.current.position.z = currentPosition.current.z;
    
    // Lampe torche du joueur distant
    if (spotLightRef.current && player.flashlightOn) {
      spotLightRef.current.position.set(currentPosition.current.x, 1, currentPosition.current.z);
      
      // Direction de la lampe selon l'angle du joueur
      const targetX = currentPosition.current.x + Math.sin(player.angle) * 10;
      const targetZ = currentPosition.current.z + Math.cos(player.angle) * 10;
      targetRef.current.position.set(targetX, 0, targetZ);
      spotLightRef.current.target = targetRef.current;
      spotLightRef.current.target.updateMatrixWorld();
    }
  });
  
  if (!isVisible && !player.flashlightOn) return null;
  
  const healthPercent = Math.max(0, player.health) / 100;
  const healthColor = healthPercent > 0.5 ? '#00ff00' : healthPercent > 0.25 ? '#ffff00' : '#ff0000';
  
  return (
    <group ref={groupRef} position={[player.x, 0, player.z]}>
      {/* Corps du joueur (visible seulement si dans le FOV) */}
      {isVisible && (
        <>
          {/* Corps principal */}
          <mesh position={[0, 0.75, 0]}>
            <capsuleGeometry args={[0.3, 1, 8, 16]} />
            <meshStandardMaterial color="#ff6b6b" />
          </mesh>
          
          {/* Indicateur de direction */}
          <mesh position={[0, 0.8, 0.4]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.15, 0.3, 8]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          
          {/* Barre de vie au-dessus de la tête */}
          <group position={[0, 1.8, 0]}>
            {/* Fond noir */}
            <mesh>
              <planeGeometry args={[0.8, 0.1]} />
              <meshBasicMaterial color="#000000" side={THREE.DoubleSide} />
            </mesh>
            {/* Barre de vie */}
            <mesh position={[(healthPercent - 1) * 0.4, 0, 0.01]}>
              <planeGeometry args={[0.8 * healthPercent, 0.08]} />
              <meshBasicMaterial color={healthColor} side={THREE.DoubleSide} />
            </mesh>
          </group>
          
          {/* Nom du joueur */}
          {/* Note: Pour un vrai jeu, utiliser @react-three/drei Text */}
        </>
      )}
      
      {/* Lampe torche (toujours visible si allumée) */}
      {player.flashlightOn && (
        <>
          <spotLight
            ref={spotLightRef}
            position={[0, 1, 0]}
            angle={Math.PI / 6}
            penumbra={0.1}
            distance={60}
            intensity={50}
            color="#ffffaa"
          />
          <primitive object={targetRef.current} />
        </>
      )}
    </group>
  );
}

export function RemotePlayers({ players, visionData }: RemotePlayersProps) {
  // Fonction pour vérifier si un joueur est visible dans le FOV
  const isPlayerVisible = (playerX: number, playerZ: number) => {
    if (visionData.raycastPoints.length === 0) return false;
    
    // Distance au joueur local
    const dx = playerX - visionData.playerX;
    const dz = playerZ - visionData.playerZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    // Si trop loin, pas visible
    if (dist > 25) return false;
    
    // Vérifier si dans le cône de vision
    const numRays = visionData.raycastPoints.length;
    for (let i = 0; i < numRays; i++) {
      const rayPoint = visionData.raycastPoints[i];
      
      // Distance entre le point de rayon et la position du joueur distant
      const rdx = playerX - rayPoint.x;
      const rdz = playerZ - rayPoint.z;
      const rayDist = Math.sqrt(rdx * rdx + rdz * rdz);
      
      if (rayDist < 2) {
        return true;
      }
      
      // Vérifier si le joueur est sur le chemin du rayon
      const rayLen = Math.sqrt(
        (rayPoint.x - visionData.playerX) ** 2 + 
        (rayPoint.z - visionData.playerZ) ** 2
      );
      
      if (rayLen > 0) {
        const t = ((playerX - visionData.playerX) * (rayPoint.x - visionData.playerX) +
                   (playerZ - visionData.playerZ) * (rayPoint.z - visionData.playerZ)) / (rayLen * rayLen);
        
        if (t > 0 && t < 1) {
          const closestX = visionData.playerX + t * (rayPoint.x - visionData.playerX);
          const closestZ = visionData.playerZ + t * (rayPoint.z - visionData.playerZ);
          const closestDist = Math.sqrt((playerX - closestX) ** 2 + (playerZ - closestZ) ** 2);
          
          if (closestDist < 1.5) {
            return true;
          }
        }
      }
    }
    
    return false;
  };
  
  return (
    <>
      {Array.from(players.values()).map(player => (
        <RemotePlayerMesh
          key={player.id}
          player={player}
          isVisible={isPlayerVisible(player.x, player.z)}
        />
      ))}
    </>
  );
}

// Composant pour les projectiles des autres joueurs
export function RemoteProjectiles({ projectiles }: { projectiles: RemoteProjectile[] }) {
  return (
    <>
      {projectiles.map(p => (
        <mesh key={p.id} position={[p.x, 0.5, p.z]}>
          <sphereGeometry args={[0.1, 8, 8]} />
          <meshStandardMaterial color="#ff0000" emissive="#ff4400" emissiveIntensity={2} />
        </mesh>
      ))}
    </>
  );
}

// Composant pour les zones de feu des autres joueurs
export function RemoteFireZones({ fireZones }: { fireZones: RemoteFireZone[] }) {
  return (
    <>
      {fireZones.map(f => (
        <group key={f.id} position={[f.x, 0.1, f.z]}>
          <pointLight intensity={2} distance={f.radius * 2} color="#ff4400" />
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[f.radius, 16]} />
            <meshBasicMaterial color="#ff4400" transparent opacity={0.6} />
          </mesh>
        </group>
      ))}
    </>
  );
}
