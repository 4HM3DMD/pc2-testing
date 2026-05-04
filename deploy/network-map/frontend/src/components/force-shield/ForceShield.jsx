import React, { useRef, useMemo, useEffect, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MAX_HITS } from "./consts";
import { useShieldControls } from "./useShieldControls";
import { createShieldMaterial } from "./shaderMaterial";

export function ForceShield({ isActive = true, posYOverride }) {
  const groupRef = useRef(null);
  const revealRef = useRef(1);
  const timeRef = useRef(0);
  const hitIdxRef = useRef(0);
  const lifeRef = useRef(1.0);
  const hitDamageRef = useRef(10);

  const [controls] = useShieldControls(lifeRef);
  const {
    debugAlwaysOn,
    posX,
    posY,
    posZ,
    scale,
    color,
    hexScale,
    hexOpacity,
    showHex,
    edgeWidth,
    fresnelPower,
    fresnelStrength,
    opacity,
    fadeStart,
    revealSpeed,
    flashSpeed,
    flashIntensity,
    noiseScale,
    noiseEdgeColor,
    noiseEdgeWidth,
    noiseEdgeIntensity,
    noiseEdgeSmoothness,
    flowScale,
    flowSpeed,
    flowIntensity,
    hitRingSpeed,
    hitRingWidth,
    hitDuration,
    hitIntensity,
    hitImpactRadius,
    hitMaxRadius,
    hitDamage,
  } = controls;

  const visible = isActive || debugAlwaysOn;
  hitDamageRef.current = hitDamage;

  const shieldMaterial = useMemo(() => createShieldMaterial(), []);

  useEffect(() => {
    const mat = shieldMaterial;
    if (!mat) return;
    const u = mat.uniforms;
    u.uColor.value.set(color);
    u.uHexScale.value = hexScale;
    u.uHexOpacity.value = hexOpacity;
    u.uShowHex.value = showHex ? 1.0 : 0.0;
    u.uEdgeWidth.value = edgeWidth;
    u.uFresnelPower.value = fresnelPower;
    u.uFresnelStrength.value = fresnelStrength;
    u.uOpacity.value = opacity;
    u.uFadeStart.value = fadeStart;
    u.uFlashSpeed.value = flashSpeed;
    u.uFlashIntensity.value = flashIntensity;
    u.uNoiseScale.value = noiseScale;
    u.uNoiseEdgeColor.value.set(noiseEdgeColor);
    u.uNoiseEdgeWidth.value = noiseEdgeWidth;
    u.uNoiseEdgeIntensity.value = noiseEdgeIntensity;
    u.uNoiseEdgeSmoothness.value = noiseEdgeSmoothness;
    u.uFlowScale.value = flowScale;
    u.uFlowSpeed.value = flowSpeed;
    u.uFlowIntensity.value = flowIntensity;
    u.uHitRingSpeed.value = hitRingSpeed;
    u.uHitRingWidth.value = hitRingWidth;
    u.uHitMaxRadius.value = hitMaxRadius;
    u.uHitDuration.value = hitDuration;
    u.uHitIntensity.value = hitIntensity;
    u.uHitImpactRadius.value = hitImpactRadius;
  }, [
    color, hexScale, hexOpacity, showHex, edgeWidth,
    fresnelPower, fresnelStrength, opacity, fadeStart,
    flashSpeed, flashIntensity, noiseScale, noiseEdgeColor,
    noiseEdgeWidth, noiseEdgeIntensity, noiseEdgeSmoothness,
    flowScale, flowSpeed, flowIntensity, hitRingSpeed,
    hitRingWidth, hitMaxRadius, hitDuration, hitIntensity,
    hitImpactRadius,
  ]);

  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      const mat = shieldMaterial;
      if (!mat) return;

      const localPoint = e.object.worldToLocal(e.point.clone());
      const idx = hitIdxRef.current % MAX_HITS;
      hitIdxRef.current += 1;

      const u = mat.uniforms;
      u.uHitPos.value[idx].copy(localPoint);
      u.uHitTime.value[idx] = timeRef.current;

      lifeRef.current = Math.max(0, lifeRef.current - hitDamageRef.current / 100);
    },
    [shieldMaterial]
  );

  useFrame((state, delta) => {
    const mat = shieldMaterial;
    if (!mat) return;

    timeRef.current = state.clock.elapsedTime;
    mat.uniforms.uTime.value = timeRef.current;
    mat.uniforms.uLife.value = lifeRef.current;

    const target = visible ? 0 : 1;
    revealRef.current = THREE.MathUtils.lerp(
      revealRef.current,
      target,
      1 - Math.exp(-revealSpeed * delta)
    );
    if (visible && revealRef.current < 0.005) revealRef.current = 0;
    if (!visible && revealRef.current > 0.995) revealRef.current = 1;

    mat.uniforms.uReveal.value = revealRef.current;
    mat.visible = revealRef.current < 1;
  });

  return (
    <group ref={groupRef} position={[posX, posYOverride ?? posY, posZ]} scale={[scale, scale, scale]}>
      <mesh onClick={handleClick}>
        <sphereGeometry args={[1.8, 64, 64]} />
        <primitive object={shieldMaterial} attach="material" />
      </mesh>
    </group>
  );
}
