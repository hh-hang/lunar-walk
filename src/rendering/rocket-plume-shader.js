// 从 aeronautic 的 TSL 喷流场、噪声与透射积分移植为 GLSL，许可见 public/licenses/aeronautic.txt。
export const plumeVertexShader = `
varying vec3 localPosition;
void main(){
  localPosition=position;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}`;

export const plumeFragmentShader = `
uniform sampler2D sceneDepth;
uniform sampler2D blackbody;
uniform vec2 viewport;
uniform mat4 projectionInverse;
uniform mat4 viewToLocal;
uniform vec3 cameraLocal;
uniform float time;
uniform float strength;
uniform float nozzleRadius;
uniform float reach;
uniform float flareSlope;
uniform float stepCount;
uniform float intensity;
uniform float coreLengthScale;
uniform float shockSpacingScale;
uniform float flowSpeed;
uniform float sootAmount;
uniform float shockHeat;
varying vec3 localPosition;

// 与原示例一致的平滑值噪声，两层叠加后沿喷射方向输运。
float hashCell(vec3 cell){
  vec3 p=fract(cell*0.3183099+vec3(0.1,0.2,0.3))*17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
}
float noise(vec3 point){
  vec3 cell=floor(point), f=fract(point);
  vec3 u=f*f*(3.0-2.0*f);
  return mix(
    mix(mix(hashCell(cell),hashCell(cell+vec3(1,0,0)),u.x),
        mix(hashCell(cell+vec3(0,1,0)),hashCell(cell+vec3(1,1,0)),u.x),u.y),
    mix(mix(hashCell(cell+vec3(0,0,1)),hashCell(cell+vec3(1,0,1)),u.x),
        mix(hashCell(cell+vec3(0,1,1)),hashCell(cell+vec3(1,1,1)),u.x),u.y),u.z);
}
float turbulence(vec3 point){
  return noise(point)*0.65+noise(point*2.17+vec3(5.3,1.7,9.1))*0.35;
}
vec3 temperatureLight(float kelvin){
  float u=(clamp((kelvin-500.0)/5500.0,0.0,1.0)*255.0+0.5)/256.0;
  vec4 sampleColor=textureLod(blackbody,vec2(u,0.5),0.0);
  return sampleColor.rgb*exp2(sampleColor.a);
}

// 在局部 +Z 真空圆锥台内求射线区间（半径 = 喷口 + z·flareSlope）。
vec2 plumeSpan(vec3 origin,vec3 direction,float farLimit){
  float nearT=0.0, farT=farLimit;
  if(abs(direction.z)<0.00001){
    if(origin.z<0.0||origin.z>reach)return vec2(0.0,-1.0);
  }else{
    float a=-origin.z/direction.z, b=(reach-origin.z)/direction.z;
    nearT=max(nearT,min(a,b));farT=min(farT,max(a,b));
  }
  float r0=nozzleRadius*1.15;
  float k=max(flareSlope,0.001);
  float rq=r0+k*origin.z;
  float A=dot(direction.xy,direction.xy)-k*k*direction.z*direction.z;
  float B=2.0*(dot(origin.xy,direction.xy)-rq*k*direction.z);
  float C=dot(origin.xy,origin.xy)-rq*rq;
  if(abs(A)<1e-7){
    if(C>0.0&&abs(B)<1e-7)return vec2(0.0,-1.0);
    if(abs(B)>1e-7){
      float t=-C/B;
      if(C>0.0)nearT=max(nearT,t); else farT=min(farT,t);
    }
  }else{
    float disc=B*B-4.0*A*C;
    if(disc<0.0){
      if(C>0.0)return vec2(0.0,-1.0);
    }else{
      float root=sqrt(max(disc,0.0));
      float t0=(-B-root)/(2.0*A);
      float t1=(-B+root)/(2.0*A);
      float tEnter=min(t0,t1);
      float tExit=max(t0,t1);
      if(A>0.0){
        nearT=max(nearT,tEnter);
        farT=min(farT,tExit);
      }else if(C>0.0){
        nearT=max(nearT,tExit);
      }else{
        farT=min(farT,tEnter);
      }
    }
  }
  if(farT<=nearT)return vec2(0.0,-1.0);
  return vec2(nearT,farT);
}

// 真空强欠膨胀：半宽按 flareSlope 锥形外扩，密度随截面积稀释。
void plumeField(vec3 point,out vec3 extinction,out vec3 emission){
  float x=max(point.z,0.0);
  float coreLength=nozzleRadius*coreLengthScale;
  float core=clamp(x/max(coreLength,1e-4),0.0,1.0);
  float halfWidth=nozzleRadius+x*flareSlope;
  float centre=pow(1.0+pow(x/max(coreLength,1e-4),3.0),-0.35);
  float coreRadius=nozzleRadius*(1.0-core)*0.85;
  float layer=max(halfWidth-coreRadius,nozzleRadius*0.05);
  float station=x+pow(max(x-coreLength,0.0),2.0)/(2.0*max(coreLength,1e-4));
  float freedom=smoothstep(0.0,coreLength*1.5,x);
  vec2 drift=vec2(sin(station*2.1-time*4.0),sin(station*1.7-time*3.4+2.0));
  vec2 lateral=point.xy-drift*halfWidth*0.1*freedom;
  float radial=length(lateral);
  float eddy=layer*0.28+nozzleRadius*0.03;
  vec3 flow=vec3(lateral/max(eddy,0.04),(station-time*flowSpeed)/max(eddy*4.0,0.12));
  float displaced=radial+(turbulence(flow)*2.0-1.0)*layer*0.55;
  float intoLayer=max(displaced-coreRadius,0.0)/layer;
  float window=1.0-smoothstep(reach*0.7,reach,x);
  float mixture=centre*exp2(-intoLayer*intoLayer)*window;

  // 近喷口弱激波；真空下游摊开。色温按超燃：淡青白透明，非煤油橙焰。
  float spacing=nozzleRadius*shockSpacingScale;
  float cells=x/spacing-0.55;
  float behind=fract(cells);
  float inviscid=nozzleRadius*clamp(1.0-x/(coreLength*2.2)*0.75,0.08,1.0);
  float lozenge=abs(behind-0.23)/0.23+radial/max(inviscid*0.85,0.001);
  float hot=(1.0-smoothstep(0.2,1.05,lozenge))*(1.0-clamp(behind/0.46,0.0,1.0)*0.55);
  float disk=hot*smoothstep(-0.15,0.0,cells)*exp(-max(cells,0.0)*0.85)*(1.0-freedom*0.7);
  // 真实稳态羽流几乎无色；仅喉口附近保留较低温弱发光便于游戏可读。
  float temperature=280.0+720.0*mixture+220.0*mixture*(1.0-mixture)*3.0+shockHeat*disk*mixture;
  float areaScale=(nozzleRadius*nozzleRadius)/max(halfWidth*halfWidth,1e-4);
  float dense=mix(1.0,0.18,smoothstep(0.0,coreLength*1.2,x))*mix(1.0,sqrt(areaScale),0.78);
  float soot=sootAmount*dense*mixture*mix(0.35,0.75,smoothstep(500.0,900.0,temperature));
  // 烟炱偏冷灰，避免橙褐；消光整体压低。
  extinction=vec3(0.92,0.95,1.05)*soot*strength*0.55;
  float activated=exp(min(7000.0*(1.0/1800.0-1.0/max(temperature,1.0)),4.5));
  vec3 gasGlow=vec3(0.55,0.72,1.0)*0.11*dense*mixture*activated*strength;
  vec3 throat=vec3(1.0,0.92,0.82)*0.045*mixture*(1.0-freedom)*strength;
  emission=extinction*temperatureLight(temperature)*0.45+gasGlow+throat;
}

void main(){
  if(strength<=0.0001)discard;
  vec2 uv=gl_FragCoord.xy/viewport;
  vec3 direction=normalize(localPosition-cameraLocal);
  float depth=texture2D(sceneDepth,uv).r;
  vec4 sceneView=projectionInverse*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);
  sceneView/=sceneView.w;
  vec3 sceneLocal=(viewToLocal*sceneView).xyz;
  float farLimit=depth>0.999999?100000.0:dot(sceneLocal-cameraLocal,direction);
  vec2 span=plumeSpan(cameraLocal,direction,farLimit);
  if(span.y<=span.x)discard;
  float steps=min(stepCount,48.0);
  float stride=(span.y-span.x)/steps;
  float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  vec3 light=vec3(0.0),through=vec3(1.0);
  for(int index=0;index<48;index++){
    if(float(index)>=steps)break;
    float t=span.x+(float(index)+0.25+jitter*0.5)*stride;
    vec3 extinction,emission;
    plumeField(cameraLocal+direction*t,extinction,emission);
    // 与原示例一致的 Beer–Lambert 透射积分，薄步长用极限式避免数值损失。
    vec3 opticalDepth=extinction*stride;
    vec3 attenuation=exp(-opticalDepth);
    vec3 share=mix(1.0-opticalDepth*0.5,(1.0-attenuation)/max(opticalDepth,vec3(0.001)),step(vec3(0.001),opticalDepth));
    light+=through*emission*share*stride;
    through*=attenuation;
    if(max(max(through.r,through.g),through.b)<0.01)break;
  }
  float coverage=1.0-dot(through,vec3(0.2126,0.7152,0.0722));
  if(coverage<0.0001&&max(max(light.r,light.g),light.b)<0.00001)discard;
  gl_FragColor=vec4(light*intensity,coverage);
}`;
