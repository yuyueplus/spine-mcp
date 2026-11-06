$input v_texcoord0, v_color0, v_color1
#include <bgfx_shader.sh>
SAMPLER2D(s_texture, 0);
uniform vec4 u_textureParams;
void main() {
  vec4 tex = texture2D(s_texture, v_texcoord0);
  // Convert straight-alpha atlas pages to PMA; PMA pages pass through.
  vec3 premultiplied = mix(tex.rgb * tex.a, tex.rgb, u_textureParams.x);
  vec3 rgb = (premultiplied * v_color0.rgb + (vec3(tex.a, tex.a, tex.a) - premultiplied) * v_color1.rgb) * v_color0.a;
  gl_FragColor = vec4(rgb, tex.a * v_color0.a);
}
