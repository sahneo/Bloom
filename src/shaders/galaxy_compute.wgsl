// GALAXY compute — intentionally unused since the flythrough rebuild.
// The new GALAXY preset (galaxy.js + galaxy.wgsl) is fully procedural:
// star positions are hash functions of vertex index + scene seed evaluated
// in the vertex shader, so there is no particle state to integrate and no
// compute pass. This file is kept as a valid no-op module in case a future
// iteration needs stateful particles again.

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
}
