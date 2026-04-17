"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, Suspense, useMemo } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";



// ── Great-circle transit line ─────────────────────────────────────────────────
// Rendered in LOCAL globe space so it rotates with the globe (sits on surface).
function GreatCircleOrbit({ color, normal, speed, phases, r = 6.01 }: {
  color: string;
  normal: [number, number, number];
  speed: number;
  phases: number[];
  r?: number;
}) {
	console.log("logging the great circle")
  const R = r;

  // Two orthonormal basis vectors spanning the orbit plane
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { u, v } = useMemo(() => {
    const n = new THREE.Vector3(...normal).normalize();
    const arb = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const uu = new THREE.Vector3().crossVectors(n, arb).normalize();
    const vv = new THREE.Vector3().crossVectors(n, uu).normalize();
    return { u: uu, v: vv };
  }, []);

  const trainRefs = useRef<(THREE.Group | null)[]>(phases.map(() => null));
  const angles = useRef([...phases]);

  const getPos = (a: number): [number, number, number] => [
    R * (Math.cos(a) * u.x + Math.sin(a) * v.x),
    R * (Math.cos(a) * u.y + Math.sin(a) * v.y),
    R * (Math.cos(a) * u.z + Math.sin(a) * v.z),
  ];

  const getTangent = (a: number) => new THREE.Vector3(
    -Math.sin(a) * u.x + Math.cos(a) * v.x,
    -Math.sin(a) * u.y + Math.cos(a) * v.y,
    -Math.sin(a) * u.z + Math.cos(a) * v.z,
  ).normalize();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const circleObject = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const [x, y, z] = getPos((i / 128) * Math.PI * 2);
      pts.push(new THREE.Vector3(x, y, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 });
    return new THREE.Line(geo, mat);
  }, []);

  useFrame((_, delta) => {
    for (let i = 0; i < angles.current.length; i++) {
      angles.current[i] = (angles.current[i] ?? 0) + delta * speed;
      const a = angles.current[i]!;
      const [x, y, z] = getPos(a);

      const ref = trainRefs.current[i];
      if (ref) {
        ref.position.set(x, y, z);
        const tangent = getTangent(a);
        const outward = new THREE.Vector3(x, y, z).normalize();
        const binormal = new THREE.Vector3().crossVectors(tangent, outward).normalize();
        ref.setRotationFromMatrix(new THREE.Matrix4().makeBasis(tangent, outward, binormal));
      }

    }
  });

  // Curved train: 8 segments each positioned + rotated along the great-circle arc.
  // In local group space (X=tangent, Y=outward, Z=binormal):
  //   arc point at angle δ → (R·sin δ, R·(cos δ − 1), 0)
  //   rotated by −δ around Z so the segment body is tangent to the sphere.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const segData = useMemo(() => {
    const HALF_ARC = 0.24; // radians each side (arc length ≈ 2.9 world units)
    const N = 8;
    const segLen = (HALF_ARC * 2 * R / N) + 0.015;
    return Array.from({ length: N }, (_, si) => {
      const delta = -HALF_ARC + (si + 0.5) / N * HALF_ARC * 2;
      return { x: R * Math.sin(delta), y: R * (Math.cos(delta) - 1), rotZ: -delta, len: segLen };
    });
  }, []);

  return (
    <>
      <primitive object={circleObject} />

      {phases.map((_, i) => (
        <group key={i} ref={(el) => { trainRefs.current[i] = el; }}>
          {segData.map(({ x, y, rotZ, len }, si) => (
            <group key={si} position={[x, y, 0]} rotation={[0, 0, rotZ]}>
              {/* Body */}
              <mesh position={[0, 0.095, 0]}>
                <boxGeometry args={[len, 0.19, 0.17]} />
                <meshStandardMaterial color={color} roughness={0.35} metalness={0.3} />
              </mesh>
              {/* Roof */}
              <mesh position={[0, 0.195, 0]}>
                <boxGeometry args={[len, 0.022, 0.145]} />
                <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} />
              </mesh>
              {/* Windows — front */}
              <mesh position={[0, 0.115, 0.087]}>
                <boxGeometry args={[len * 0.85, 0.058, 0.001]} />
                <meshStandardMaterial color="#d0ecff" transparent opacity={0.85} roughness={0.05} metalness={0.6} />
              </mesh>
              {/* Windows — back */}
              <mesh position={[0, 0.115, -0.087]}>
                <boxGeometry args={[len * 0.85, 0.058, 0.001]} />
                <meshStandardMaterial color="#d0ecff" transparent opacity={0.85} roughness={0.05} metalness={0.6} />
              </mesh>
            </group>
          ))}
        </group>
      ))}
    </>
  );
}

// ── Spinning globe ────────────────────────────────────────────────────────────
function Globe() {
  const groupRef = useRef<THREE.Group>(null);
  const R = 6;

  const overlayTexture = useLoader(THREE.TextureLoader, "/homepageoverlay.jpg");
  overlayTexture.wrapS = THREE.RepeatWrapping;
  overlayTexture.wrapT = THREE.RepeatWrapping;
  overlayTexture.repeat.set(2, 1);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.055;
    }
  });

  return (
    <group ref={groupRef} position={[0, -7.0, 0]}>
      <mesh>
        <sphereGeometry args={[R, 96, 96]} />
        <meshBasicMaterial map={overlayTexture} />
      </mesh>
      {/* Transit lines are children of the globe → rotate with it → sit on surface */}
      <GreatCircleOrbit color="#d03527" normal={[0, 0, 1]}         speed={0.38} phases={[0, Math.PI * 2 / 3, Math.PI * 4 / 3]}                          r={6.01} />
      <GreatCircleOrbit color="#facc15" normal={[1, 0.3, 0]}       speed={0.55} phases={[Math.PI / 4, Math.PI, Math.PI * 7 / 4]}                         r={6.01} />
      <GreatCircleOrbit color="#3b82f6" normal={[0.4, 1, 0.6]}     speed={0.47} phases={[0, Math.PI * 2 / 3, Math.PI * 4 / 3]}                           r={6.01} />
      <GreatCircleOrbit color="#a3e635" normal={[-0.6, 0.2, 0.8]}  speed={0.63} phases={[Math.PI / 2, Math.PI * 3 / 2]}                                  r={6.01} />
      <GreatCircleOrbit color="#38bdf8" normal={[0.3, 0.8, -0.5]}  speed={0.42} phases={[Math.PI * 0.15, Math.PI * 0.82, Math.PI * 1.5]}                  r={6.01} />
    </group>
  );
}

// ── 3D scene ──────────────────────────────────────────────────────────────────
function Scene() {
  return (
    <>
      <ambientLight intensity={0.2} />
      <directionalLight position={[8, 4, 5]} intensity={3.5} color="#ffffff" />
      <directionalLight position={[-6, -2, -4]} intensity={0.1} color="#d0d8e8" />
      <Globe />
    </>
  );
}

// ── Landing page ──────────────────────────────────────────────────────────────
export default function LandingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
  console.log("Setting ready")
    setReady(true);
    const t = setTimeout(() => setVisible(true), 60);
    // Prefetch map page JS bundle + heavy data assets
    router.prefetch("/map");
    void Promise.allSettled([
      fetch("/Neighbourhoods - 4326.geojson"),
      fetch("/api/population"),
      fetch("/api/traffic"),
    ]);
    return () => clearTimeout(t);
  }, [router]);

  const fadeUp = (delay: string) => ({
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(18px)",
    transition: `opacity 1s ease ${delay}, transform 1s ease ${delay}`,
  });

  return (
    <main className="relative min-h-screen overflow-hidden bg-white font-sans">

      {/* Background overlay image */}
      <div
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: "url('/homepageoverlay.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          opacity: 0.3,
        }}
      />

      {/* 3D globe canvas — full screen, behind everything */}
      {ready && (
        <div className="absolute inset-0 z-0">
          <Canvas
            camera={{ position: [0, 0, 7], fov: 45 }}
            gl={{ antialias: true, alpha: true }}
            style={{ background: "transparent" }}
          >
            <Suspense fallback={null}>
              <Scene />
            </Suspense>
          </Canvas>
        </div>
      )}

      {/* UI layer */}
      <div className="relative z-10 flex min-h-screen flex-col">

        {/* Hero */}
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-64">

          {/* SVG filter for rounding text terminals */}
          <svg style={{ position: "absolute", width: 0, height: 0 }}>
            <defs>
              <filter id="round-text" x="-5%" y="-5%" width="110%" height="110%">
                <feMorphology operator="dilate" radius="8" result="expanded" />
                <feGaussianBlur stdDeviation="6" result="blurred" />
                <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 60 -20" result="threshold" />
                <feComposite in="SourceGraphic" in2="threshold" operator="in" />
              </filter>
            </defs>
          </svg>

          {/* Title */}
          <h1
            className="mb-3 select-none text-center leading-none text-stone-800"
            style={{
              fontFamily: '"Google Sans Display", "Google Sans", sans-serif',
              fontWeight: 700,
              fontSize: "clamp(3.5rem, 10vw, 8rem)",
              letterSpacing: "-0.04em",
              lineHeight: "0.9",
              filter: "url(#round-text)",
              ...fadeUp("0.2s"),
            }}
          >
            Transit Planner
          </h1>
          <p
            className="mb-6 select-none text-center font-normal text-stone-500"
            style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", ...fadeUp("0.28s") }}
          >
            Plan at scale. Visualize city data in seconds.
          </p>

          {/* CTA button — matches map's "Generate Route" style */}
          <Link
            href="/map"
            className="mt-6 flex h-[72px] items-center gap-3 rounded-xl border border-stone-900 bg-stone-900 px-7 text-xl font-normal text-white shadow-sm transition-all hover:bg-stone-800"
            style={{ ...fadeUp("0.35s"), opacity: 0.9, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
          >
            Start Mapping
            <span style={{color: "white", fontWeight: 700}}>→</span>
          </Link>

          <Link
            href="/about"
            className="mt-4 text-xs text-stone-400 underline-offset-2 transition-colors hover:text-stone-600 hover:underline"
            style={{ ...fadeUp("0.45s") }}
          >
            Read more
          </Link>
        </div>
      </div>
    </main>
  );
}
