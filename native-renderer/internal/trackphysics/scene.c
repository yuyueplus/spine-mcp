#include "track.h"
#include "box2d/box2d.h"
#include <math.h>

int physics_bake(const PhysicsBody* input,int count,const PhysicsSegment* rails,int rail_count,
 float gx,float gy,float units,int fps,int hz,int substeps,int frames,TrackSample* out){
 if(count<1||count>128||rail_count<0||rail_count>2048||frames<2||fps<1||hz<fps||hz%fps||units<=0)return 1;
 b2WorldDef wd=b2DefaultWorldDef();wd.gravity=(b2Vec2){gx/units,gy/units};
 b2WorldId world=b2CreateWorld(&wd);b2BodyDef sd=b2DefaultBodyDef();b2BodyId fixed=b2CreateBody(world,&sd);
 for(int i=0;i<rail_count;i++){
  const PhysicsSegment* r=rails+i;b2ShapeDef s=b2DefaultShapeDef();s.material.friction=r->friction;s.material.restitution=r->restitution;
  s.filter.categoryBits=r->category;s.filter.maskBits=r->mask;
  b2Capsule c={{r->ax/units,r->ay/units},{r->bx/units,r->by/units},r->radius/units};b2CreateCapsuleShape(fixed,&s,&c);
 }
 b2BodyId bodies[128]={0};float previous[128]={0},angle[128]={0};int stride=hz/fps;
 for(int step=0;step<=(frames-1)*stride;step++){
  double time=(double)step/hz;
  for(int i=0;i<count;i++)if(B2_IS_NULL(bodies[i])&&time+1e-7>=input[i].spawn){
   const PhysicsBody* p=input+i;b2BodyDef d=b2DefaultBodyDef();d.type=b2_dynamicBody;
   d.position=(b2Vec2){p->x/units,p->y/units};d.rotation=b2MakeRot(p->angle);
   d.linearVelocity=(b2Vec2){p->vx/units,p->vy/units};d.angularVelocity=p->omega;
   d.linearDamping=p->linear_damping;d.angularDamping=p->angular_damping;
   bodies[i]=b2CreateBody(world,&d);b2ShapeDef s=b2DefaultShapeDef();s.density=p->density;
   s.material.friction=p->friction;s.material.restitution=p->restitution;s.filter.categoryBits=p->category;s.filter.maskBits=p->mask;
   b2Circle circle={{0,0},p->radius/units};b2CreateCircleShape(bodies[i],&s,&circle);
   previous[i]=atan2f(sinf(p->angle),cosf(p->angle));angle[i]=p->angle;
  }
  for(int i=0;i<count;i++)if(B2_IS_NON_NULL(bodies[i])){b2Rot r=b2Body_GetRotation(bodies[i]);float raw=atan2f(r.s,r.c),delta=raw-previous[i];if(delta>3.14159265f)delta-=6.28318531f;if(delta< -3.14159265f)delta+=6.28318531f;angle[i]+=delta;previous[i]=raw;}
  if(step%stride==0)for(int i=0;i<count;i++){
   TrackSample* s=out+(step/stride)*count+i;const PhysicsBody* p=input+i;
   if(B2_IS_NULL(bodies[i])){*s=(TrackSample){p->x,p->y,p->angle,p->vx,p->vy,p->omega,0};continue;}
   b2Vec2 v=b2Body_GetLinearVelocity(bodies[i]),pos=b2Body_GetPosition(bodies[i]);
   *s=(TrackSample){pos.x*units,pos.y*units,angle[i],v.x*units,v.y*units,b2Body_GetAngularVelocity(bodies[i]),1};
  }
  if(step==(frames-1)*stride)break;b2World_Step(world,1.0f/hz,substeps);
 }
 b2DestroyWorld(world);return 0;
}
