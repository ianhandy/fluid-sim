'use strict';

// ── Configuration ──────────────────────────────────────────────────────────
const config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    DENSITY_DISSIPATION: 0.97,
    VELOCITY_DISSIPATION: 0.98,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    VISCOSITY: 0.3,
    COLOR_MODE: 'rainbow',
    BLOOM_INTENSITY: 0.4,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_ITERATIONS: 8,
    SUNRAYS: false,
    TRANSPARENT: false,
};

// FunForrest palette
const FUNFORREST = {
    bg: [0.141, 0.071, 0.0],       // #241200
    gold: [0.867, 0.757, 0.396],    // #DDC165
    lightGold: [1.0, 0.914, 0.639], // #FFE9A3
    orange: [0.898, 0.349, 0.110],  // #E5591C
};

// ── WebGL Setup ────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

let gl = canvas.getContext('webgl2', params);
const isWebGL2 = !!gl;
if (!gl) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
if (!gl) throw new Error('WebGL not supported');

let ext;
if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    ext = {
        formatRGBA: { internalFormat: gl.RGBA16F, format: gl.RGBA },
        formatRG: { internalFormat: gl.RG16F, format: gl.RG },
        formatR: { internalFormat: gl.R16F, format: gl.RED },
        halfFloatTexType: gl.HALF_FLOAT,
        supportLinearFiltering: !!gl.getExtension('OES_texture_float_linear'),
    };
} else {
    const halfFloat = gl.getExtension('OES_texture_half_float');
    ext = {
        formatRGBA: { internalFormat: gl.RGBA, format: gl.RGBA },
        formatRG: { internalFormat: gl.RGBA, format: gl.RGBA },
        formatR: { internalFormat: gl.RGBA, format: gl.RGBA },
        halfFloatTexType: halfFloat ? halfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE,
        supportLinearFiltering: !!gl.getExtension('OES_texture_half_float_linear'),
    };
}

const filterType = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
}
resizeCanvas();

// ── Shader Compilation ────────────────────────────────────────────────────
function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
    return shader;
}

function createProgram(vertSrc, fragSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));

    const uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(prog, i);
        uniforms[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { program: prog, uniforms, bind() { gl.useProgram(prog); } };
}

const glslVersion = isWebGL2 ? '#version 300 es' : '';
const fragPrecision = 'precision highp float;\nprecision highp sampler2D;\n';

function vertexShader() {
    if (isWebGL2) return `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
out vec2 vL, vR, vT, vB;
uniform vec2 texelSize;
void main() {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
    return `precision highp float;
attribute vec2 aPosition;
varying vec2 vUv;
varying vec2 vL, vR, vT, vB;
uniform vec2 texelSize;
void main() {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
}

function frag(body) {
    if (isWebGL2) return `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL, vR, vT, vB;
out vec4 fragColor;
${body}`;
    return `precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL, vR, vT, vB;
#define fragColor gl_FragColor
${body}`;
}

function tex2D(isWebGL2) {
    return isWebGL2 ? 'texture' : 'texture2D';
}
const T = tex2D(isWebGL2);

// ── Shader Sources ─────────────────────────────────────────────────────────
const baseVert = vertexShader();

const clearShader = createProgram(baseVert, frag(`
uniform sampler2D uTexture;
uniform float value;
void main() {
    fragColor = value * ${T}(uTexture, vUv);
}
`));

const splatShader = createProgram(baseVert, frag(`
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main() {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p,p) / radius) * color;
    vec3 base = ${T}(uTarget, vUv).xyz;
    fragColor = vec4(base + splat, 1.0);
}
`));

const advectionShader = createProgram(baseVert, frag(`
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform vec2 dyeTexelSize;
uniform float dt;
uniform float dissipation;
void main() {
    vec2 coord = vUv - dt * ${T}(uVelocity, vUv).xy * texelSize;
    vec4 result = ${T}(uSource, coord);
    fragColor = dissipation * result;
}
`));

const divergenceShader = createProgram(baseVert, frag(`
uniform sampler2D uVelocity;
void main() {
    float L = ${T}(uVelocity, vL).x;
    float R = ${T}(uVelocity, vR).x;
    float T_ = ${T}(uVelocity, vT).y;
    float B = ${T}(uVelocity, vB).y;
    float div = 0.5 * (R - L + T_ - B);
    fragColor = vec4(div, 0.0, 0.0, 1.0);
}
`));

const curlShader = createProgram(baseVert, frag(`
uniform sampler2D uVelocity;
void main() {
    float L = ${T}(uVelocity, vL).y;
    float R = ${T}(uVelocity, vR).y;
    float T_ = ${T}(uVelocity, vT).x;
    float B = ${T}(uVelocity, vB).x;
    float vorticity = R - L - T_ + B;
    fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`));

const vorticityShader = createProgram(baseVert, frag(`
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main() {
    float L = ${T}(uCurl, vL).x;
    float R = ${T}(uCurl, vR).x;
    float T_ = ${T}(uCurl, vT).x;
    float B = ${T}(uCurl, vB).x;
    float C = ${T}(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T_) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = ${T}(uVelocity, vUv).xy;
    velocity += force * dt;
    fragColor = vec4(velocity, 0.0, 1.0);
}
`));

const pressureShader = createProgram(baseVert, frag(`
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
    float L = ${T}(uPressure, vL).x;
    float R = ${T}(uPressure, vR).x;
    float T_ = ${T}(uPressure, vT).x;
    float B = ${T}(uPressure, vB).x;
    float divergence = ${T}(uDivergence, vUv).x;
    float pressure = (L + R + B + T_ - divergence) * 0.25;
    fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`));

const gradientSubtractShader = createProgram(baseVert, frag(`
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
    float L = ${T}(uPressure, vL).x;
    float R = ${T}(uPressure, vR).x;
    float T_ = ${T}(uPressure, vT).x;
    float B = ${T}(uPressure, vB).x;
    vec2 velocity = ${T}(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T_ - B);
    fragColor = vec4(velocity, 0.0, 1.0);
}
`));

const displayShader = createProgram(baseVert, frag(`
uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform float bloomIntensity;
uniform vec3 backgroundColor;
void main() {
    vec3 c = ${T}(uTexture, vUv).rgb;
    vec3 bloom = ${T}(uBloom, vUv).rgb;
    c += bloom * bloomIntensity;
    float a = max(c.r, max(c.g, c.b));
    c = mix(backgroundColor, c, clamp(a * 2.0, 0.0, 1.0));
    fragColor = vec4(c, 1.0);
}
`));

const bloomPrefilterShader = createProgram(baseVert, frag(`
uniform sampler2D uTexture;
uniform vec3 curve;
uniform float threshold;
void main() {
    vec3 c = ${T}(uTexture, vUv).rgb;
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - curve.x, 0.0, curve.y);
    rq = curve.z * rq * rq;
    c *= max(rq, br - threshold) / max(br, 0.0001);
    fragColor = vec4(c, 0.0);
}
`));

const bloomBlurShader = createProgram(baseVert, frag(`
uniform sampler2D uTexture;
uniform vec2 texelSize;
uniform vec2 direction;
void main() {
    vec3 sum = vec3(0.0);
    // 9-tap gaussian
    float weights[5];
    weights[0] = 0.227027;
    weights[1] = 0.1945946;
    weights[2] = 0.1216216;
    weights[3] = 0.054054;
    weights[4] = 0.016216;
    vec2 off = direction * texelSize;
    sum += ${T}(uTexture, vUv).rgb * weights[0];
    for (int i = 1; i < 5; i++) {
        sum += ${T}(uTexture, vUv + off * float(i)).rgb * weights[i];
        sum += ${T}(uTexture, vUv - off * float(i)).rgb * weights[i];
    }
    fragColor = vec4(sum, 1.0);
}
`));

const bloomFinalShader = createProgram(baseVert, frag(`
uniform sampler2D uTexture;
uniform float intensity;
void main() {
    fragColor = vec4(${T}(uTexture, vUv).rgb * intensity, 1.0);
}
`));

// ── Fullscreen Quad ────────────────────────────────────────────────────────
const quadVerts = new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]);
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function blit(target) {
    if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
}

// ── Framebuffer Objects ────────────────────────────────────────────────────
function getResolution(resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
    const min = Math.round(resolution);
    const max = Math.round(resolution * aspectRatio);
    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
        return { width: max, height: min };
    return { width: min, height: max };
}

function createFBO(w, h, internalFormat, format, type, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const texelSizeX = 1.0 / w;
    const texelSizeY = 1.0 / h;
    return { texture, fbo, width: w, height: h, texelSizeX, texelSizeY,
        attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
}

function createDoubleFBO(w, h, internalFormat, format, type, filter) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, filter);
    let fbo2 = createFBO(w, h, internalFormat, format, type, filter);
    return {
        width: w, height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read() { return fbo1; },
        set read(v) { fbo1 = v; },
        get write() { return fbo2; },
        set write(v) { fbo2 = v; },
        swap() { const tmp = fbo1; fbo1 = fbo2; fbo2 = tmp; },
    };
}

// ── State ──────────────────────────────────────────────────────────────────
let dye, velocity, divergence, curl, pressure;
let bloomFramebuffers = [];

function initFramebuffers() {
    const simRes = getResolution(config.SIM_RESOLUTION);
    const dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const rg = ext.formatRG;
    const r = ext.formatR;

    dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filterType);
    velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filterType);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

    initBloomFramebuffers();
}

function initBloomFramebuffers() {
    const res = getResolution(256);
    bloomFramebuffers = [];
    const rgba = ext.formatRGBA;
    const texType = ext.halfFloatTexType;
    let w = res.width, h = res.height;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
        const w1 = w >> 1, h1 = h >> 1;
        if (w1 < 2 || h1 < 2) break;
        const fbo = createFBO(w1, h1, rgba.internalFormat, rgba.format, texType, filterType);
        bloomFramebuffers.push(fbo);
        w = w1; h = h1;
    }
}

initFramebuffers();

// ── Pointers (mouse/touch) ─────────────────────────────────────────────────
class Pointer {
    constructor() {
        this.id = -1;
        this.texcoordX = 0; this.texcoordY = 0;
        this.prevTexcoordX = 0; this.prevTexcoordY = 0;
        this.deltaX = 0; this.deltaY = 0;
        this.down = false;
        this.moved = false;
        this.color = [0.3, 0, 0];
    }
}

let pointers = [new Pointer()];
let splatStack = [];

function updatePointerDownData(pointer, id, posX, posY) {
    pointer.id = id;
    pointer.down = true;
    pointer.moved = false;
    pointer.texcoordX = posX / canvas.clientWidth;
    pointer.texcoordY = 1.0 - posY / canvas.clientHeight;
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.deltaX = 0;
    pointer.deltaY = 0;
    pointer.color = generateColor();
}

function updatePointerMoveData(pointer, posX, posY) {
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = posX / canvas.clientWidth;
    pointer.texcoordY = 1.0 - posY / canvas.clientHeight;
    pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
    pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
    pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
}

function updatePointerUpData(pointer) {
    pointer.down = false;
}

function correctDeltaX(delta) {
    const aspectRatio = canvas.clientWidth / canvas.clientHeight;
    if (aspectRatio < 1) delta *= aspectRatio;
    return delta;
}

function correctDeltaY(delta) {
    const aspectRatio = canvas.clientWidth / canvas.clientHeight;
    if (aspectRatio > 1) delta /= aspectRatio;
    return delta;
}

// ── Color Generation ───────────────────────────────────────────────────────
function generateColor() {
    const mode = config.COLOR_MODE;
    if (mode === 'funforrest') {
        const colors = [FUNFORREST.gold, FUNFORREST.lightGold, FUNFORREST.orange];
        const c = colors[Math.floor(Math.random() * colors.length)];
        return [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8];
    }
    if (mode === 'monochrome') {
        const v = 0.5 + Math.random() * 0.5;
        return [v, v, v];
    }
    if (mode === 'neon') {
        const hue = Math.random();
        const c = HSVtoRGB(hue, 1.0, 1.0);
        return [c.r * 1.2, c.g * 1.2, c.b * 1.2];
    }
    // rainbow
    const c = HSVtoRGB(Math.random(), 1.0, 1.0);
    return [c.r * 0.15, c.g * 0.15, c.b * 0.15];
}

function HSVtoRGB(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return { r, g, b };
}

// ── Input Events ───────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
    const p = pointers[0];
    updatePointerDownData(p, -1, e.offsetX, e.offsetY);
});

canvas.addEventListener('mousemove', e => {
    const p = pointers[0];
    if (!p.down) return;
    updatePointerMoveData(p, e.offsetX, e.offsetY);
});

window.addEventListener('mouseup', () => {
    updatePointerUpData(pointers[0]);
});

canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const touches = e.targetTouches;
    while (pointers.length < touches.length) pointers.push(new Pointer());
    for (let i = 0; i < touches.length; i++) {
        updatePointerDownData(pointers[i], touches[i].identifier,
            touches[i].pageX, touches[i].pageY);
    }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touches = e.targetTouches;
    for (let i = 0; i < touches.length; i++) {
        const ptr = pointers.find(p => p.id === touches[i].identifier);
        if (ptr) updatePointerMoveData(ptr, touches[i].pageX, touches[i].pageY);
    }
}, { passive: false });

window.addEventListener('touchend', e => {
    const touches = e.changedTouches;
    for (let i = 0; i < touches.length; i++) {
        const ptr = pointers.find(p => p.id === touches[i].identifier);
        if (ptr) updatePointerUpData(ptr);
    }
});

// Keyboard: space for random splats
window.addEventListener('keydown', e => {
    if (e.code === 'Space') splatStack.push(Math.floor(Math.random() * 15) + 5);
});

// ── Simulation Steps ───────────────────────────────────────────────────────
function splat(x, y, dx, dy, color) {
    splatShader.bind();
    gl.uniform1i(splatShader.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatShader.uniforms.aspectRatio, canvas.clientWidth / canvas.clientHeight);
    gl.uniform2f(splatShader.uniforms.point, x, y);
    gl.uniform3f(splatShader.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatShader.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatShader.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatShader.uniforms.color, color[0], color[1], color[2]);
    blit(dye.write);
    dye.swap();
}

function correctRadius(radius) {
    const aspectRatio = canvas.clientWidth / canvas.clientHeight;
    if (aspectRatio > 1) radius *= aspectRatio;
    return radius;
}

function multipleSplats(amount) {
    for (let i = 0; i < amount; i++) {
        const color = generateColor();
        color[0] *= 10.0;
        color[1] *= 10.0;
        color[2] *= 10.0;
        const x = Math.random();
        const y = Math.random();
        const dx = 1000 * (Math.random() - 0.5);
        const dy = 1000 * (Math.random() - 0.5);
        splat(x, y, dx, dy, color);
    }
}

function step(dt) {
    gl.disable(gl.BLEND);

    // Curl
    curlShader.bind();
    gl.uniform2f(curlShader.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlShader.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    // Vorticity confinement
    vorticityShader.bind();
    gl.uniform2f(vorticityShader.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityShader.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityShader.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityShader.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityShader.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    // Divergence
    divergenceShader.bind();
    gl.uniform2f(divergenceShader.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceShader.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    // Clear pressure
    clearShader.bind();
    gl.uniform1i(clearShader.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearShader.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    // Pressure solve (Jacobi)
    pressureShader.bind();
    gl.uniform2f(pressureShader.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureShader.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureShader.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }

    // Gradient subtract
    gradientSubtractShader.bind();
    gl.uniform2f(gradientSubtractShader.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientSubtractShader.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientSubtractShader.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    // Advect velocity
    advectionShader.bind();
    gl.uniform2f(advectionShader.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionShader.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(advectionShader.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionShader.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionShader.uniforms.dt, dt);
    gl.uniform1f(advectionShader.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    // Advect dye
    gl.uniform2f(advectionShader.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionShader.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionShader.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionShader.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
}

function applyBloom(source, destination) {
    if (bloomFramebuffers.length < 2) return;

    let last = destination;

    // Prefilter
    bloomPrefilterShader.bind();
    const knee = config.BLOOM_THRESHOLD * 0.7;
    const curve0 = config.BLOOM_THRESHOLD - knee;
    const curve1 = knee * 2.0;
    const curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterShader.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterShader.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterShader.uniforms.uTexture, source.attach(0));
    blit(bloomFramebuffers[0]);

    // Downsample + blur
    bloomBlurShader.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        const dest = bloomFramebuffers[Math.min(i + 1, bloomFramebuffers.length - 1)];
        if (i === bloomFramebuffers.length - 1) break;
        gl.uniform2f(bloomBlurShader.uniforms.texelSize,
            bloomFramebuffers[i].texelSizeX, bloomFramebuffers[i].texelSizeY);
        gl.uniform2f(bloomBlurShader.uniforms.direction, 1.0, 0.0);
        gl.uniform1i(bloomBlurShader.uniforms.uTexture, bloomFramebuffers[i].attach(0));
        blit(dest);
    }

    // Upsample + blur
    for (let i = bloomFramebuffers.length - 1; i > 0; i--) {
        gl.uniform2f(bloomBlurShader.uniforms.texelSize,
            bloomFramebuffers[i].texelSizeX, bloomFramebuffers[i].texelSizeY);
        gl.uniform2f(bloomBlurShader.uniforms.direction, 0.0, 1.0);
        gl.uniform1i(bloomBlurShader.uniforms.uTexture, bloomFramebuffers[i].attach(0));

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        blit(bloomFramebuffers[i - 1]);
        gl.disable(gl.BLEND);
    }

    // Final bloom pass to destination
    bloomFinalShader.bind();
    gl.uniform1i(bloomFinalShader.uniforms.uTexture, bloomFramebuffers[0].attach(0));
    gl.uniform1f(bloomFinalShader.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(last);
}

function getBackgroundColor() {
    if (config.COLOR_MODE === 'funforrest') return FUNFORREST.bg;
    return [0, 0, 0];
}

function render(target) {
    const bg = getBackgroundColor();

    if (config.BLOOM_INTENSITY > 0 && bloomFramebuffers.length > 1) {
        const bloomDest = bloomFramebuffers[bloomFramebuffers.length - 1];
        applyBloom(dye.read, bloomDest);

        displayShader.bind();
        gl.uniform1i(displayShader.uniforms.uTexture, dye.read.attach(0));
        gl.uniform1i(displayShader.uniforms.uBloom, bloomFramebuffers[0].attach(1));
        gl.uniform1f(displayShader.uniforms.bloomIntensity, config.BLOOM_INTENSITY);
    } else {
        displayShader.bind();
        gl.uniform1i(displayShader.uniforms.uTexture, dye.read.attach(0));
        gl.uniform1i(displayShader.uniforms.uBloom, dye.read.attach(1));
        gl.uniform1f(displayShader.uniforms.bloomIntensity, 0.0);
    }
    gl.uniform3f(displayShader.uniforms.backgroundColor, bg[0], bg[1], bg[2]);
    blit(target);
}

// ── Main Loop ──────────────────────────────────────────────────────────────
let lastUpdateTime = Date.now();

// Start with some random splats
multipleSplats(Math.floor(Math.random() * 10) + 5);

function update() {
    const now = Date.now();
    let dt = (now - lastUpdateTime) / 1000;
    dt = Math.min(dt, 0.016666); // cap at 60fps timestep
    lastUpdateTime = now;

    resizeCanvas();

    // Process splat stack
    if (splatStack.length > 0) {
        multipleSplats(splatStack.pop());
    }

    // Apply pointer input
    for (const p of pointers) {
        if (p.moved) {
            p.moved = false;
            const dx = p.deltaX * config.SPLAT_FORCE;
            const dy = p.deltaY * config.SPLAT_FORCE;
            splat(p.texcoordX, p.texcoordY, dx, dy, p.color);
        }
    }

    step(dt);
    render(null);
    requestAnimationFrame(update);
}

requestAnimationFrame(update);

// ── Controls Binding ───────────────────────────────────────────────────────
function bindSlider(id, configKey, valId, transform) {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!slider) return;
    slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        config[configKey] = transform ? transform(v) : v;
        if (valEl) valEl.textContent = slider.value;
    });
}

bindSlider('viscosity', 'VISCOSITY', 'viscVal');
bindSlider('curl', 'CURL', 'curlVal');
bindSlider('pressure', 'PRESSURE_ITERATIONS', 'pressVal', v => Math.round(v));
bindSlider('splatRadius', 'SPLAT_RADIUS', 'splatVal');
bindSlider('splatForce', 'SPLAT_FORCE', 'forceVal');
bindSlider('dissipation', 'DENSITY_DISSIPATION', 'dissVal');
bindSlider('bloomIntensity', 'BLOOM_INTENSITY', 'bloomVal');
bindSlider('bloomThreshold', 'BLOOM_THRESHOLD', 'bloomThreshVal');

const colorSelect = document.getElementById('colorMode');
if (colorSelect) {
    colorSelect.addEventListener('change', () => {
        config.COLOR_MODE = colorSelect.value;
    });
}

// Toggle controls panel
const toggleBtn = document.getElementById('toggleBtn');
const controlsPanel = document.getElementById('controls');
if (toggleBtn && controlsPanel) {
    toggleBtn.addEventListener('click', () => {
        controlsPanel.classList.toggle('hidden');
    });
}
