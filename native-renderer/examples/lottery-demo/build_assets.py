"""Build deterministic sphere sprites and a Spine atlas for the local demo.

The studio plate is supplied separately. No image generation or speech service
is called by the running Go server.
"""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import shutil
import tarfile
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def ball_label(number, font_path):
    image = Image.new("RGB", (256, 256), "white")
    font = ImageFont.truetype(font_path, 236)
    text = f"{number:02d}"
    box = font.getbbox(text)
    glyph = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), "white")
    ImageDraw.Draw(glyph).text((-box[0], -box[1]), text, font=font, fill=(8, 10, 13))
    glyph = glyph.resize((min(178, glyph.width), 168), Image.Resampling.LANCZOS)
    image.paste(glyph, ((256-glyph.width)//2, (256-glyph.height)//2))
    return np.asarray(image).astype(np.float32) / 255


def label_faces():
    """Twelve circular number decals, distributed over an icosahedral sphere."""
    phi = (1 + np.sqrt(5)) / 2
    centers = np.array([(0, a, b*phi) for a in (-1, 1) for b in (-1, 1)]
                       + [(a, b*phi, 0) for a in (-1, 1) for b in (-1, 1)]
                       + [(b*phi, 0, a) for a in (-1, 1) for b in (-1, 1)], dtype=float)
    centers /= np.linalg.norm(centers, axis=1)[:, None]
    front = centers[3]
    axis = np.cross(front, [0, 0, 1]); sine = np.linalg.norm(axis)
    axis /= sine
    cross = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    rotation = np.eye(3) + sine*cross + (1-front[2])*(cross@cross)
    centers = centers @ rotation.T
    faces = []
    for center in centers:
        up = np.array([0., 1., 0.])
        if abs(center @ up) > .98:
            up = np.array([0., 0., 1.])
        up -= center*(center@up); up /= np.linalg.norm(up)
        right = np.cross(up, center)
        faces.append((center, right, up))
    return faces


def build(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / "manifest.json").exists():
        raise RuntimeError("Assets already sealed; choose a new output directory")
    (out / "images/balls").mkdir(parents=True, exist_ok=True)
    (out / "audio").mkdir(exist_ok=True)
    for kind in ("normal", "special"):
        for number in range(1, 50):
            name = f"{kind}-{number:02d}.wav"
            source = args.voices / name
            if not source.is_file():
                raise ValueError(f"Missing offline callout: {source}")
            shutil.copyfile(source, out / "audio" / name)
    voice_manifest = args.voices / "voice-manifest.json"
    if voice_manifest.is_file():
        shutil.copyfile(voice_manifest, out / "audio/voice-manifest.json")
    plate = Image.open(args.plate).convert("RGBA").resize((1280, 720), Image.Resampling.LANCZOS)
    plate.save(out / "background.png")
    plate.save(out / "images/background.png")
    rules = json.loads(args.rules.read_text(encoding="utf-8"))
    colors = rules["colors"]
    kinds = {n: kind for kind, nums in colors.items() for n in nums}
    rgb = {"red": [0.64, 0.17, 0.22], "blue": [0.19, 0.29, 0.56], "green": [0.17, 0.46, 0.29]}
    size, count, cell, across = 96, 24, 100, 20
    bake_size = size*2
    yy, xx = np.mgrid[0:bake_size, 0:bake_size]
    x = (xx + .5 - bake_size / 2) / (bake_size / 2 - 3)
    y = -(yy + .5 - bake_size / 2) / (bake_size / 2 - 3)
    rad2 = x * x + y * y
    z = np.sqrt(np.maximum(0, 1 - rad2))
    normal = np.stack((x, y, z), axis=-1)
    alpha = np.clip((1 - np.sqrt(rad2)) * 90, 0, 1)
    light = np.array([-.38, .54, .75]); light /= np.linalg.norm(light)
    diffuse = np.maximum(0, normal @ light)
    half = light + np.array([0, 0, 1]); half /= np.linalg.norm(half)
    specular = np.maximum(0, normal @ half) ** 260 * .48
    rim = (1 - z) ** 5 * .025
    lighting = .72 + .22 * diffuse
    faces = label_faces()
    axis = np.array([.27, 1, .13]); axis /= np.linalg.norm(axis)
    cross = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    rotated = []
    for frame in range(count):
        angle = frame * np.pi * 2 / count
        rotation = np.eye(3) * np.cos(angle) + (1 - np.cos(angle)) * np.outer(axis, axis) + np.sin(angle) * cross
        local = normal @ rotation
        masks = []
        for center, right, up in faces:
            facing = local @ center
            u, v = local @ right, local @ up
            mask = (facing > 0) & (u * u + v * v < .43 ** 2) & (rad2 < 1)
            tx = np.clip(((u / .43 + 1) * .5 * 255).astype(np.uint8), 0, 255)
            ty = np.clip(((1 - v / .43) * .5 * 255).astype(np.uint8), 0, 255)
            masks.append((mask, tx, ty))
        rotated.append(masks)
    pages, atlas, tile = [], [], 0
    page = None
    font_path = str(args.font)
    for number in range(1, 50):
        label = ball_label(number, font_path)
        for frame in range(count):
            if tile % (across * across) == 0:
                if page is not None:
                    page.save(out / f"balls-{len(pages)}.png")
                page = Image.new("RGBA", (2048, 2048))
                pages.append(f"balls-{len(pages)+1}.png")
                atlas.extend(["" if len(pages) > 1 else "", pages[-1], "size: 2048, 2048", "format: RGBA8888", "filter: Linear, Linear", "repeat: none", "pma: false"])
            base = np.empty((bake_size, bake_size, 3), dtype=np.float32); base[:] = rgb[kinds[number]]
            for mask, tx, ty in rotated[frame]:
                base[mask] = label[ty[mask], tx[mask]] * .94
            result = np.clip(base * lighting[..., None] + specular[..., None] + rim[..., None], 0, 1)
            rgba = np.dstack(((result * 255).astype(np.uint8), (alpha * 255).astype(np.uint8)))
            image = Image.fromarray(rgba, "RGBA").resize((size, size), Image.Resampling.LANCZOS)
            name = f"balls/{number:02d}-{frame:02d}"
            image.save(out / "images" / (name + ".png"))
            index = tile % (across * across)
            px, py = (index % across) * cell + 2, (index // across) * cell + 2
            page.paste(image, (px, py))
            atlas.extend([name, f"  bounds: {px}, {py}, {size}, {size}", "  offsets: 0, 0, 96, 96", "  rotate: false"])
            tile += 1
    page.save(out / f"balls-{len(pages)}.png")
    # A code-generated contact shadow underneath the compact resting pile.
    sy, sx = np.mgrid[0:48, 0:192]
    shadow_alpha = np.exp(-(((sx-96)/66)**2 + ((sy-24)/11)**2)*1.8)*.42
    shadow = np.dstack((np.full((48,192), 12), np.full((48,192), 19), np.full((48,192), 26), shadow_alpha*255)).astype(np.uint8)
    Image.fromarray(shadow, "RGBA").save(out / "images/pile-shadow.png")
    shadow_page = Image.new("RGBA", (256,64)); shadow_page.paste(Image.fromarray(shadow, "RGBA"), (2,2)); shadow_page.save(out / "pile-shadow.png")
    head = ["background.png", "size: 1280, 720", "format: RGBA8888", "filter: Linear, Linear", "repeat: none", "pma: false", "background", "  bounds: 0, 0, 1280, 720", "  offsets: 0, 0, 1280, 720", "  rotate: false", "", "pile-shadow.png", "size: 256, 64", "format: RGBA8888", "filter: Linear, Linear", "repeat: none", "pma: false", "pile-shadow", "  bounds: 2, 2, 192, 48", "  offsets: 0, 0, 192, 48", "  rotate: false"]
    (out / "scene.atlas").write_text("\n".join(head + atlas) + "\n", encoding="utf-8")
    (out / "rules.json").write_text(json.dumps({"colors": colors, "zodiac49Label": "和", "source": rules["inspection"]["sourcePage"]}, ensure_ascii=False, indent=2), encoding="utf-8")
    # Fixed local player dependency, identical to the existing viewer example.
    url = "https://registry.npmjs.org/hls.js/-/hls.js-1.6.13.tgz"
    integrity = "sha512-hNEzjZNHf5bFrUNvdS4/1RjIanuJ6szpWNfTaX5I6WfGynWXGT7K/YQLYtemSvFExzeMdgdE4SsyVLJbd5PcZA=="
    with urllib.request.urlopen(url, timeout=40) as response:
        data = response.read(32 * 1024 * 1024)
    if "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode() != integrity:
        raise ValueError("Player package integrity mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for source, destination in [("package/dist/hls.light.min.js", "hls.min.js"), ("package/LICENSE", "HLS-LICENSE.txt")]:
            (out / destination).write_bytes(archive.extractfile(source).read())
    manifest = {"schema": "lottery-demo-assets/1", "styleVersion": "reference-v2", "decalsPerBall": 12, "width": 1280, "height": 720, "sphereFrames": count, "sphereSize": size, "pageCount": len(pages) + 2, "colors": colors, "plateSource": str(args.plate), "files": {}}
    for file in sorted(out.rglob("*")):
        if file.is_file():
            manifest["files"][file.relative_to(out).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"assets": str(out), "sphereFrames": tile, "atlasPages": len(pages) + 2}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plate", type=pathlib.Path, required=True)
    parser.add_argument("--rules", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--voices", type=pathlib.Path, required=True)
    parser.add_argument("--font", type=pathlib.Path, default=pathlib.Path(r"C:\Windows\Fonts\impact.ttf"))
    build(parser.parse_args())
