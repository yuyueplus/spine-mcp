#pragma once
typedef struct TrackSample { float x,y,angle,vx,vy,omega; int visible; } TrackSample;
int track_bake(const double* releases, const double* angles, int frames, TrackSample* out, double* settled);
typedef struct PhysicsBody {
 float x,y,angle,vx,vy,omega,radius,density,friction,restitution,linear_damping,angular_damping,spawn;
 unsigned int category,mask;
} PhysicsBody;
typedef struct PhysicsSegment {float ax,ay,bx,by,radius,friction,restitution;unsigned int category,mask;} PhysicsSegment;
int physics_bake(const PhysicsBody* bodies,int body_count,const PhysicsSegment* segments,int segment_count,
 float gx,float gy,float units,int fps,int step_hz,int substeps,int frames,TrackSample* out);
