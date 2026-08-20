import { useEffect, useRef } from 'react';

const MOON_CHARS =
  " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@";
const FIELD_CHARS = '  ..::--==++**##@@'.split('');

const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};

const smooth = (t: number) => t * t * (3 - 2 * t);

const noise2D = (x: number, y: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);

  const ux = smooth(fx);
  const uy = smooth(fy);

  return (
    a * (1 - ux) * (1 - uy) +
    b * ux * (1 - uy) +
    c * (1 - ux) * uy +
    d * ux * uy
  );
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export default function AsciiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let time = 0;
    let rafId = 0;
    const mouse = { x: -1000, y: -1000 };

    const resize = () => {
      width = canvas.parentElement!.offsetWidth;
      height = canvas.parentElement!.offsetHeight;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      cols = width < 768 ? 90 : 128;
      const cellW = width / cols;
      const cellH = cellW * 1.18;
      rows = Math.ceil(height / cellH);
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };

    const draw = () => {
      ctx.fillStyle = '#0A0A0A';
      ctx.fillRect(0, 0, width, height);

      time += 0.012;

      const cellW = width / cols;
      const cellH = cellW * 1.18;

      const moonX = width * 0.5;
      const moonY = height * 0.5;
      const moonRadius = Math.min(width, height) * 0.24;

      ctx.font = `${cellH * 0.84}px "Fragment Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Light direction for the moon
      let lx = 1.0;
      let ly = 0.15;
      let lz = -0.6;
      const lLen = Math.hypot(lx, ly, lz);
      lx /= lLen;
      ly /= lLen;
      lz /= lLen;

      for (let r = 0; r < rows; r++) {
        const rowY = r * cellH + cellH / 2;

        const laneNorm = rowY / height;
        const laneSpeed = 1.75;

        for (let c = 0; c < cols; c++) {
          const x = c * cellW + cellW / 2;
          const y = rowY;

          const dxMoon = x - moonX;
          const dyMoon = y - moonY;
          const distMoon = Math.hypot(dxMoon, dyMoon);
          const normMoon = distMoon / moonRadius;
          const angleMoon = Math.atan2(dyMoon, dxMoon);

          const mouseDistance = Math.hypot(x - mouse.x, y - mouse.y);
          const mouseField = Math.exp(-mouseDistance * 0.0038);

          let char = '';
          let opacity = 0;
          let drawX = x;
          let drawY = y;

          if (normMoon < 1.0) {
            const localX = dxMoon / moonRadius;
            const localY = -(y - moonY) / moonRadius;
            const localR2 = localX * localX + localY * localY;
            const z = Math.sqrt(Math.max(0, 1.0 - localR2));

            // Rotate moon surface over time to create a visible self-rotation
            const angle = time * 0.32;
            const px = localX * Math.cos(angle) - z * Math.sin(angle);
            const py = localY;
            const pz = localX * Math.sin(angle) + z * Math.cos(angle);

            let diffuse = px * lx + py * ly + pz * lz;
            diffuse = Math.max(0, diffuse);

            const maria =
              noise2D(px * 2.6 + 4.2, py * 2.6 - 1.7) * 0.6 +
              noise2D(pz * 3.4 - 8.1, py * 3.4 + 5.4) * 0.4;
            const craters =
              noise2D(px * 12.0 + py * 6.0 + 30.0, pz * 12.0 - px * 4.0 - 20.0) * 0.65 +
              noise2D(px * 20.0 - 11.0, py * 20.0 + 7.0) * 0.35;

            const albedo = clamp(0.76 + craters * 0.14 - maria * 0.18, 0.52, 0.92);

            if (diffuse > 0 && diffuse < 0.15) {
              diffuse += Math.sin(px * 50 + py * 50) * 0.03;
              diffuse = Math.max(0, diffuse);
            }

            const ambient = 0.015;
            const intensity = ambient + diffuse * albedo * 1.3;
            const moonIdx = clamp(
              Math.floor(intensity * (MOON_CHARS.length - 1)),
              0,
              MOON_CHARS.length - 1
            );

            char = MOON_CHARS[moonIdx];
            opacity = clamp(0.2 + intensity * 0.82, 0.2, 1);

            // Slight orbital drag so the moon is not completely static in the field
            const edgeBend = Math.exp(-Math.abs(normMoon - 1.0) * 8) * 4;
            drawX += -Math.sin(angleMoon) * edgeBend;
            drawY += Math.cos(angleMoon) * edgeBend * 0.4;

            drawX += Math.sin(time * 3.6 + r * 0.32 + c * 0.11) * mouseField * 16;
            drawY += Math.cos(time * 2.8 + c * 0.24) * mouseField * 5;
          } else {
            // Strong horizontal streaming field, not a static grid
            const sampleX =
              c * 0.085 -
              time * (1.8 + laneSpeed * 1.6) +
              Math.sin(time * 4.2 + r * 0.28 + c * 0.08) * mouseField * 1.8;
            const sampleY =
              r * 0.11 +
              Math.sin(c * 0.025 + time * 1.2) * 0.6 +
              Math.cos(time * 3.4 + c * 0.2) * mouseField * 1.1;

            const flowA = noise2D(sampleX, sampleY);
            const flowB = noise2D(sampleX * 1.7 + 20, sampleY * 0.8 - 14);
            const wave =
              Math.sin(sampleX * 1.9 + laneNorm * 14) * 0.5 +
              Math.cos(sampleY * 2.4 - time * 2.1) * 0.5;

            let density = flowA * 0.42 + flowB * 0.28 + (wave * 0.5 + 0.5) * 0.3;

            // Add a clear orbiting disturbance around the moon
            const orbitBand = Math.exp(-Math.pow((normMoon - 1.12) * 5.5, 2));
            density += orbitBand * 0.16;

            if (density > 0.38) {
              const fieldIdx = clamp(
                Math.floor(density * (FIELD_CHARS.length - 1)),
                0,
                FIELD_CHARS.length - 1
              );
              char = FIELD_CHARS[fieldIdx];
              opacity = 0.035 + density * 0.24;

              // Real horizontal travel
              drawX += (laneSpeed * 8 + flowB * 16) % (cellW * 3);
              drawY += Math.sin(sampleX * 2.2 + time + laneNorm * 8) * 1.8;

              // Bend flow around the moon
              const swirl = orbitBand * 10;
              drawX += -Math.sin(angleMoon) * swirl;
              drawY += Math.cos(angleMoon) * swirl * 0.6;

              drawX += Math.sin(time * 4.8 + r * 0.35 + c * 0.1) * mouseField * 18;
              drawY += Math.cos(time * 3.2 + c * 0.25) * mouseField * 6;
              density += mouseField * 0.24;
            }
          }

          if (!char || opacity <= 0.02) continue;

          ctx.fillStyle = `rgba(232, 230, 224, ${opacity})`;
          ctx.fillText(char, drawX, drawY);
        }
      }

      rafId = requestAnimationFrame(draw);
    };

    document.fonts.ready.then(() => {
      resize();
      draw();
    });

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'block',
      }}
    />
  );
}
