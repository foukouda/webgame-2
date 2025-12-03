import Scene3D from '@/components/Scene3D';

export default function Home() {
  return (
    <main className="w-full h-screen bg-black">
      <div className="absolute top-4 left-4 z-10 text-white">
        <h1 className="text-3xl font-bold mb-2">Next.js + Three.js</h1>
        <p className="text-sm opacity-80">Utilisez la souris pour manipuler la scène 3D</p>
      </div>
      <Scene3D />
    </main>
  );
}
