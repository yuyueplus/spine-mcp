#include "track.h"
#include "box2d/box2d.h"
#include <math.h>
#include <stdbool.h>

// Physics coordinates ARE the wide camera pixels. Both magnifiers apply only
// a uniform view transform; no second result-track coordinate system exists.
#define PPM 10.0f
#define RADIUS 9.9f
#define ARC_POINTS 32
#define HALF_CHANNEL_WIDTH 10.75f
#define RAIL_RADIUS .30f
typedef struct Pixel {float x,y;} Pixel;
// The lower support follows the visible inner lip of the glass channel. The
// old top centerline was close to the upper rim and left a visible air gap.
static Pixel support_point(float angle,int special,float offset){
    float direction=special?1.0f:-1.0f;
    float nx=direction*sinf(angle)/141.0f,ny=-cosf(angle)/146.0f,len=hypotf(nx,ny);
    return(Pixel){618+direction*141*sinf(angle)+offset*nx/len,
                 397-146*cosf(angle)+offset*ny/len};
}
static int track_points(Pixel* points,int special){
    float begin=asinf(14.0f/141.0f);
    for(int i=0;i<ARC_POINTS;i++)points[i]=support_point(begin+(1.35f-begin)*i/(ARC_POINTS-1),special,HALF_CHANNEL_WIDTH);
    if(special){points[ARC_POINTS]=(Pixel){773,389};points[ARC_POINTS+1]=(Pixel){770,414};points[ARC_POINTS+2]=(Pixel){767,429};return ARC_POINTS+3;}
    points[ARC_POINTS]=(Pixel){469,382};points[ARC_POINTS+1]=(Pixel){471,401};points[ARC_POINTS+2]=(Pixel){475,419};points[ARC_POINTS+3]=(Pixel){478,434};return ARC_POINTS+4;
}
static TrackSample entry(int special,float angle){
    Pixel points[ARC_POINTS+4];track_points(points,special);
    float dx=points[1].x-points[0].x,dy=points[1].y-points[0].y,len=hypotf(dx,dy);
    Pixel start=support_point(asinf(14.0f/141.0f),special,RADIUS+RAIL_RADIUS);
    return(TrackSample){start.x,start.y,angle,95*dx/len,95*dy/len,(special?-1:1)*95/RADIUS,0};
}
static b2Vec2 world(float x,float y){return(b2Vec2){x/PPM,-y/PPM};}
static void rail(b2BodyId body,Pixel a,Pixel b,int category){
    b2ShapeDef d=b2DefaultShapeDef();d.material.friction=.30f;d.material.restitution=.10f;d.material.rollingResistance=.08f;
    d.filter.categoryBits=(uint64_t)category;d.filter.maskBits=(uint64_t)category;
    b2Capsule cap={world(a.x,a.y),world(b.x,b.y),RAIL_RADIUS/PPM};b2CreateCapsuleShape(body,&d,&cap);
}
static Pixel curve(const Pixel* p,int count,float t){
    int k=(int)t;if(k>=count-1)return p[count-1];float u=t-k,u2=u*u,u3=u2*u;
    Pixel a=k?p[k-1]:(Pixel){2*p[0].x-p[1].x,2*p[0].y-p[1].y};
    Pixel b=p[k],c=p[k+1],d=k+2<count?p[k+2]:(Pixel){2*c.x-b.x,2*c.y-b.y};
    return(Pixel){.5f*((2*b.x)+(-a.x+c.x)*u+(2*a.x-5*b.x+4*c.x-d.x)*u2+(-a.x+3*b.x-3*c.x+d.x)*u3),
                  .5f*((2*b.y)+(-a.y+c.y)*u+(2*a.y-5*b.y+4*c.y-d.y)*u2+(-a.y+3*b.y-3*c.y+d.y)*u3)};
}
static void channel(b2BodyId walls,const Pixel* points,int count,Pixel stop,int category){
    for(int side=-1;side<=1;side+=2){
        Pixel previous={0};
        for(int k=0;k<=320;k++){
            float t=(count-1)*(float)k/320;Pixel c=curve(points,count,t);
            Pixel before=curve(points,count,fmaxf(0,t-.002f)),after=curve(points,count,fminf(count-1,t+.002f));
            float dx=after.x-before.x,dy=after.y-before.y,len=sqrtf(dx*dx+dy*dy);
            Pixel edge={c.x+side*HALF_CHANNEL_WIDTH*dy/len,c.y-side*HALF_CHANNEL_WIDTH*dx/len};
            if(k)rail(walls,previous,edge,category);previous=edge;
        }
    }
    Pixel prior=points[count-2],end=points[count-1];float dx=end.x-prior.x,dy=end.y-prior.y,len=sqrtf(dx*dx+dy*dy);dx/=len;dy/=len;
    Pixel center={stop.x+(RADIUS+.30f)*dx,stop.y+(RADIUS+.30f)*dy};
    rail(walls,(Pixel){center.x-dy*12,center.y+dx*12},(Pixel){center.x+dy*12,center.y-dx*12},category);
}
int track_bake(const double* releases,const double* angles,int frames,TrackSample* out,double* settled){
    if(!releases||!angles||!out||!settled||frames<2||frames>7201)return 1;
    b2WorldDef wd=b2DefaultWorldDef();wd.gravity=(b2Vec2){0,-350.0f/PPM};wd.restitutionThreshold=.3f;
    wd.contactHertz=480;wd.contactDampingRatio=1;wd.maxContactPushSpeed=60;
    b2WorldId w=b2CreateWorld(&wd);b2BodyDef sd=b2DefaultBodyDef();b2BodyId walls=b2CreateBody(w,&sd);
    Pixel left[ARC_POINTS+4],right[ARC_POINTS+4];int left_count=track_points(left,0),right_count=track_points(right,1);
    channel(walls,left,left_count,(Pixel){475,419},1);channel(walls,right,right_count,(Pixel){770,414},2);
    b2BodyId bodies[7]={0};double quiet[7]={0};float previous_raw[7]={0},unwrapped[7]={0};
    for(int i=0;i<7;i++)settled[i]=-1;
    const float dt=1.0f/120;
    for(int step=0;step<=(frames-1)*2;step++){
        double now=(double)step/120;
        for(int i=0;i<7;i++)if(B2_IS_NULL(bodies[i])&&now+1e-7>=releases[i]){
            for(int j=0;j<i;j++)if(B2_IS_NON_NULL(bodies[j]))b2Body_SetBullet(bodies[j],false);
            TrackSample start=entry(i==6,(float)angles[i]);
            b2BodyDef d=b2DefaultBodyDef();d.type=b2_dynamicBody;d.position=world(start.x,start.y);
            d.linearVelocity=(b2Vec2){start.vx/PPM,-start.vy/PPM};d.angularVelocity=start.omega;d.rotation=b2MakeRot((float)angles[i]);
            d.angularDamping=.8f;d.linearDamping=2.0f;d.sleepThreshold=.04f;d.isBullet=true;
            bodies[i]=b2CreateBody(w,&d);b2ShapeDef shape=b2DefaultShapeDef();shape.density=1;
            shape.material.friction=.36f;shape.material.restitution=.12f;shape.material.rollingResistance=.10f;
            shape.filter.categoryBits=i==6?2:1;shape.filter.maskBits=i==6?2:1;
            b2Circle circle={{0,0},RADIUS/PPM};b2CreateCircleShape(bodies[i],&shape,&circle);
            previous_raw[i]=atan2f(sinf((float)angles[i]),cosf((float)angles[i]));unwrapped[i]=(float)angles[i];
        }
        if(step%2==0)for(int i=0;i<7;i++){
            TrackSample* s=&out[(step/2)*7+i];
            if(B2_IS_NULL(bodies[i])){*s=entry(i==6,(float)angles[i]);continue;}
            b2Vec2 p=b2Body_GetPosition(bodies[i]),v=b2Body_GetLinearVelocity(bodies[i]);b2Rot r=b2Body_GetRotation(bodies[i]);
            float raw=atan2f(r.s,r.c),delta=raw-previous_raw[i];if(delta>3.14159265f)delta-=6.28318531f;if(delta< -3.14159265f)delta+=6.28318531f;
            unwrapped[i]+=delta;previous_raw[i]=raw;
            *s=(TrackSample){p.x*PPM,-p.y*PPM,unwrapped[i],v.x*PPM,-v.y*PPM,b2Body_GetAngularVelocity(bodies[i]),1};
        }
        if(step==(frames-1)*2)break;
        // Air in the narrow result channel cushions an incoming ball near the
        // existing stack. Apply smooth velocity damping, never a position fit.
        for(int i=1;i<6;i++)if(B2_IS_NON_NULL(bodies[i])){
            b2Vec2 p=b2Body_GetPosition(bodies[i]);float nearest=1e9f;
            for(int j=0;j<i;j++)if(B2_IS_NON_NULL(bodies[j])){
                b2Vec2 q=b2Body_GetPosition(bodies[j]);float d=hypotf(p.x-q.x,p.y-q.y)*PPM;if(d<nearest)nearest=d;
            }
            float u=fmaxf(0,fminf(1,(35-nearest)/15));
            b2Body_SetLinearDamping(bodies[i],2.0f+8*u*u*(3-2*u));
        }
        b2World_Step(w,dt,16);
        for(int i=0;i<7;i++)if(B2_IS_NON_NULL(bodies[i])){
            b2Vec2 v=b2Body_GetLinearVelocity(bodies[i]);float omega=b2Body_GetAngularVelocity(bodies[i]);
            if(now>releases[i]+.2&&b2Length(v)<.04f&&fabsf(omega)<.045f)quiet[i]+=1.0/120;else quiet[i]=0;
            if(settled[i]<0&&quiet[i]>.15)settled[i]=now+1.0/120;
        }
    }
    b2DestroyWorld(w);return 0;
}
