// Generic glTF 2.0 binary container (.glb) packer, parser, and buffer/accessor builder
// for Omnishell Kinetic 3D scenes (Web Babylon/Three, Desktop Bevy wgpu, Phone Filament).

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const GLB_VERSION = 2;
export const CHUNK_JSON = 0x4e4f534a; // "JSON"
export const CHUNK_BIN = 0x004e4942; // "BIN\0"
export const COMPONENT_FLOAT = 5126;
export const COMPONENT_UNSIGNED_INT = 5125;

export function yawToQuat(yaw, pitch = 0, roll = 0) {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ];
}

export function hexToRgba(hex) {
  const clean = hex.replace(/^#/, '');
  const n = parseInt(clean, 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    1.0,
  ];
}

export class BinaryCollector {
  constructor() {
    this.parts = [];
    this.byteLength = 0;
    this.bufferViews = [];
    this.accessors = [];
  }

  _pad4() {
    const rem = this.byteLength % 4;
    if (rem !== 0) {
      const pad = new Uint8Array(4 - rem);
      this.parts.push(pad);
      this.byteLength += pad.byteLength;
    }
  }

  addBytes(bytes, target) {
    this._pad4();
    const byteOffset = this.byteLength;
    const u8 =
      bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    this.parts.push(copy);
    this.byteLength += copy.byteLength;
    const viewIndex = this.bufferViews.length;
    const view = {
      buffer: 0,
      byteOffset,
      byteLength: copy.byteLength,
      ...(target ? { target } : {}),
    };
    this.bufferViews.push(view);
    return viewIndex;
  }

  addFloatAccessor(floats, type, count) {
    const f32 = floats instanceof Float32Array ? floats : new Float32Array(floats);
    const viewIndex = this.addBytes(f32);
    const components = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : type === 'VEC3' ? 3 : 4;
    const min = new Array(components).fill(Infinity);
    const max = new Array(components).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < components; c++) {
        const v = f32[i * components + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    const accIndex = this.accessors.length;
    this.accessors.push({
      bufferView: viewIndex,
      byteOffset: 0,
      componentType: COMPONENT_FLOAT,
      count,
      type,
      ...(count > 0 ? { min, max } : {}),
    });
    return accIndex;
  }

  addIndexAccessor(indices) {
    const u32 = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    const viewIndex = this.addBytes(u32);
    const accIndex = this.accessors.length;
    this.accessors.push({
      bufferView: viewIndex,
      byteOffset: 0,
      componentType: COMPONENT_UNSIGNED_INT,
      count: u32.length,
      type: 'SCALAR',
    });
    return accIndex;
  }

  finish() {
    this._pad4();
    const out = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const p of this.parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  }
}

export function buildRibbonPrimitive(bin, pathA, pathB, materialIndex, uvScaleZ = 0.1) {
  const n = Math.min(pathA.length, pathB.length);
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const indices = new Uint32Array(Math.max(0, n - 1) * 6);

  for (let i = 0; i < n; i++) {
    const a = pathA[i];
    const b = pathB[i];
    const baseV = i * 2;

    positions[baseV * 3 + 0] = a.x;
    positions[baseV * 3 + 1] = a.y;
    positions[baseV * 3 + 2] = a.z;

    positions[(baseV + 1) * 3 + 0] = b.x;
    positions[(baseV + 1) * 3 + 1] = b.y;
    positions[(baseV + 1) * 3 + 2] = b.z;

    normals[baseV * 3 + 1] = 1;
    normals[(baseV + 1) * 3 + 1] = 1;

    const vCoord = a.z * uvScaleZ;
    uvs[baseV * 2 + 0] = 0;
    uvs[baseV * 2 + 1] = vCoord;
    uvs[(baseV + 1) * 2 + 0] = 1;
    uvs[(baseV + 1) * 2 + 1] = vCoord;
  }

  let idx = 0;
  for (let i = 0; i < n - 1; i++) {
    const v0 = i * 2;
    const v1 = v0 + 1;
    const v2 = v0 + 2;
    const v3 = v0 + 3;
    indices[idx++] = v0;
    indices[idx++] = v2;
    indices[idx++] = v1;
    indices[idx++] = v1;
    indices[idx++] = v2;
    indices[idx++] = v3;
  }

  const posAcc = bin.addFloatAccessor(positions, 'VEC3', n * 2);
  const normAcc = bin.addFloatAccessor(normals, 'VEC3', n * 2);
  const uvAcc = bin.addFloatAccessor(uvs, 'VEC2', n * 2);
  const indAcc = bin.addIndexAccessor(indices);

  return {
    attributes: {
      POSITION: posAcc,
      NORMAL: normAcc,
      TEXCOORD_0: uvAcc,
    },
    indices: indAcc,
    material: materialIndex,
    mode: 4, // TRIANGLES
  };
}

function encodeUtf8(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = ((c - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(u8) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(u8);
  }
  let out = '';
  let i = 0;
  while (i < u8.length) {
    const b0 = u8[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = u8[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = u8[i++] & 0x3f;
      const b2 = u8[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = u8[i++] & 0x3f;
      const b2 = u8[i++] & 0x3f;
      const b3 = u8[i++] & 0x3f;
      const cp = (((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3) - 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/** Pack a glTF 2.0 JSON object and binary buffer into a standard `.glb` binary container. */
export function packGlb(gltfJson, binBytes = new Uint8Array(0)) {
  const jsonBytes = encodeUtf8(JSON.stringify(gltfJson));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonChunkLen = jsonBytes.byteLength + jsonPad;

  const binPad = (4 - (binBytes.byteLength % 4)) % 4;
  const binChunkLen = binBytes.byteLength + binPad;

  const totalLen = 12 + 8 + jsonChunkLen + (binChunkLen > 0 ? 8 + binChunkLen : 0);
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  // 12-byte GLB header
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLen, true);

  // JSON chunk header + payload padded with ASCII space (0x20)
  view.setUint32(12, jsonChunkLen, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) {
    out[20 + jsonBytes.byteLength + i] = 0x20;
  }

  // BIN chunk header + payload padded with 0x00
  if (binChunkLen > 0) {
    const binHeaderOffset = 20 + jsonChunkLen;
    view.setUint32(binHeaderOffset, binChunkLen, true);
    view.setUint32(binHeaderOffset + 4, CHUNK_BIN, true);
    out.set(binBytes, binHeaderOffset + 8);
  }

  return out;
}

/** Parse a `.glb` binary container back into `{ magic, version, gltf, bin }`. */
export function parseGlb(glbBytes) {
  const u8 = glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes);
  if (u8.byteLength < 20) throw new Error('stage_gltf: truncated GLB header');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error(`stage_gltf: invalid GLB magic 0x${magic.toString(16)}`);
  const version = view.getUint32(4, true);
  const totalLen = view.getUint32(8, true);
  if (totalLen !== u8.byteLength) {
    throw new Error(`stage_gltf: GLB length mismatch (${totalLen} vs ${u8.byteLength})`);
  }

  const jsonLen = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== CHUNK_JSON) throw new Error('stage_gltf: first chunk must be JSON');
  const jsonSlice = u8.subarray(20, 20 + jsonLen);
  const gltf = JSON.parse(decodeUtf8(jsonSlice).trimEnd());

  let bin = new Uint8Array(0);
  const binHeaderOffset = 20 + jsonLen;
  if (binHeaderOffset + 8 <= u8.byteLength) {
    const binLen = view.getUint32(binHeaderOffset, true);
    const binType = view.getUint32(binHeaderOffset + 4, true);
    if (binType !== CHUNK_BIN) throw new Error('stage_gltf: second chunk must be BIN');
    bin = u8.subarray(binHeaderOffset + 8, binHeaderOffset + 8 + binLen);
  }

  return { magic, version, gltf, bin };
}
