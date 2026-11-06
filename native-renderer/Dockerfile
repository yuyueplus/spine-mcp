FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libvulkan1 libx11-6 libgl1 libegl1 libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Build on Linux first using build.sh; Windows DLLs are not portable to this image.
COPY build/bin/Release/ /app/
ENV NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility
WORKDIR /app
ENTRYPOINT ["/app/spine-worker"]
