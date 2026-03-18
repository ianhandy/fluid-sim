# Fluid Simulation

Interactive GPU fluid dynamics using WebGL. Implements Navier-Stokes equations on the GPU with real-time dye advection, vorticity confinement, and bloom post-processing.

## Features

- **Navier-Stokes solver** — semi-Lagrangian advection, Jacobi pressure iteration, vorticity confinement
- **Interactive** — mouse/touch creates velocity splats with dye injection
- **Multi-touch** — full mobile support with multiple simultaneous touches
- **Bloom** — threshold + gaussian blur post-processing for glowing fluid
- **Color modes** — FunForrest (gold/orange on dark), Rainbow, Monochrome, Neon
- **Controls** — viscosity, curl, pressure iterations, splat radius/force, dissipation, bloom

## Usage

Serve the directory with any static file server:

```bash
npx serve .
# or
python3 -m http.server
```

Open in browser. Click/touch and drag to create fluid motion. Press Space for random splats.

## Controls

| Parameter | Effect |
|-----------|--------|
| Viscosity | Fluid thickness |
| Curl | Vorticity confinement strength |
| Pressure Iterations | Solver accuracy (higher = more accurate) |
| Splat Radius | Size of interaction splats |
| Splat Force | Velocity magnitude of splats |
| Dissipation | How quickly dye fades |
| Bloom Intensity/Threshold | Glow effect strength |
| Color Mode | FunForrest, Rainbow, Monochrome, Neon |

## References

- Jos Stam, "Stable Fluids" (1999)
- PavelDoGreat/WebGL-Fluid-Simulation
