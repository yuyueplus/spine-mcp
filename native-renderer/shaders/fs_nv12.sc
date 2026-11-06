$input v_texcoord0, v_color0, v_color1
#include <bgfx_shader.sh>
SAMPLER2D(s_texture, 0);
uniform vec4 u_yuvParams;
vec3 rgbAt(float x, float y) {
  vec2 uv = (vec2(x, y) + vec2(0.5, 0.5)) / u_yuvParams.xy;
  uv.y = mix(uv.y, 1.0 - uv.y, u_yuvParams.w);
  return texture2D(s_texture, uv).rgb;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec2 chroma(float x, float y) {
  vec3 c = (rgbAt(x,y) + rgbAt(x+1.0,y) + rgbAt(x,y+1.0) + rgbAt(x+1.0,y+1.0)) * 0.25;
  float y709 = luma(c);
  return (vec2(128.0,128.0) + 224.0 * vec2((c.b-y709)/1.8556,(c.r-y709)/1.5748)) / 255.0;
}
void main() {
  vec2 p = floor(v_texcoord0 * vec2(u_yuvParams.x * 0.25, u_yuvParams.y * 1.5));
  float x = p.x * 4.0;
  if (p.y < u_yuvParams.y) {
    gl_FragColor = (vec4(16.0,16.0,16.0,16.0) + 219.0 * vec4(
      luma(rgbAt(x,p.y)), luma(rgbAt(x+1.0,p.y)),
      luma(rgbAt(x+2.0,p.y)), luma(rgbAt(x+3.0,p.y)))) / 255.0;
  } else {
    float y = (p.y - u_yuvParams.y) * 2.0;
    gl_FragColor = vec4(chroma(x,y),chroma(x+2.0,y));
  }
}
