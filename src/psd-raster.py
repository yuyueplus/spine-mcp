"""Bounded, offline PSD raster helper. No shell, network, GUI or source writes."""
import hashlib
import importlib.metadata
import json
import logging
import math
import pathlib
import sys
import warnings

EXPECTED = {"aggdraw": "1.4.1", "attrs": "26.1.0", "numpy": "2.5.4", "pillow": "13.0.0", "psd-tools": "1.26.0", "scipy": "1.18.1"}


def versions():
    actual = {name: importlib.metadata.version(name) for name in EXPECTED}
    if actual != EXPECTED:
        raise ValueError("PSD raster runtime differs from its pinned requirements")
    return actual


def metric(first, second):
    import numpy as np
    a = np.asarray(first.convert("RGBA")).astype(np.float64)
    b = np.asarray(second.convert("RGBA")).astype(np.float64)
    if a.shape != b.shape:
        raise ValueError("PSD reference dimensions differ")
    a[:, :, :3] *= a[:, :, 3:4] / 255
    b[:, :, :3] *= b[:, :, 3:4] / 255
    d = np.abs(a - b)
    return {"maxPremultipliedError": float(d.max()), "meanPremultipliedError": float(d.mean()), "fractionAbove3": float((d.max(axis=2) > 3).mean())}


def render(request):
    from psd_tools import PSDImage
    source = pathlib.Path(request["input"]).resolve(strict=True)
    output = pathlib.Path(request["output"]).resolve(strict=True)
    if not output.is_dir() or any(output.iterdir()):
        raise ValueError("PSD helper needs one new empty output directory")
    if source.stat().st_size > 32 * 1024 ** 2:
        raise ValueError("PSD source exceeds 32 MiB")
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    if before != request["sourceSha256"]:
        raise ValueError("PSD changed before rasterization")
    with source.open("rb") as stream:
        header = stream.read(26)
    if len(header) != 26 or header[:6] != b"8BPS\0\1" or int.from_bytes(header[22:24], "big") != 8 or int.from_bytes(header[24:26], "big") != 3:
        raise ValueError("Rasterization requires standard RGB8 PSD")
    width, height = int.from_bytes(header[18:22], "big"), int.from_bytes(header[14:18], "big")
    if min(width, height) < 1 or max(width, height) > 4096 or width * height > 4194304:
        raise ValueError("Advanced PSD canvas exceeds 4096 per dimension / four megapixels")
    psd = PSDImage.open(source)
    all_layers = list(psd.descendants())
    if len(all_layers) > 128:
        raise ValueError("Advanced PSD exceeds 128 layers/groups")
    blockers, operations, semantics = [], [], []
    active_adjustments = {"brightnesscontrast", "levels", "curves", "exposure", "huesaturation", "invert", "posterize", "threshold"}
    supported_kinds = {"pixel", "shape", "type", "smartobject", "group"} | active_adjustments
    total_pixels = 0
    for layer in all_layers:
        depth, parent = 0, layer.parent
        while parent is not None and parent is not psd:
            depth += 1
            parent = parent.parent
        if depth > 16:
            raise ValueError("Advanced PSD exceeds 16 group levels")
        total_pixels += max(0, layer.width) * max(0, layer.height)
        if total_pixels > 64000000 or max(layer.width, layer.height) > 8192:
            raise ValueError("Advanced PSD exceeds its layer geometry budget")
        if not layer.is_visible():
            continue
        if layer.kind not in supported_kinds:
            blockers.append({"layer": layer.name, "reason": "Unsupported raster kind: " + layer.kind})
        if layer.kind in active_adjustments:
            operations.append({"layer": layer.name, "type": "adjustment", "kind": layer.kind})
        if layer.vector_mask is not None:
            paths = layer.vector_mask.paths
            if sum(len(p) if hasattr(p, "__len__") else 1 for p in paths) > 20000:
                raise ValueError("Vector mask exceeds 20,000 knots")
            operations.append({"layer": layer.name, "type": "vector_mask"})
        if layer.effects.enabled:
            for effect in layer.effects:
                if not effect.enabled:
                    continue
                name = type(effect).__name__
                if name != "Stroke":
                    blockers.append({"layer": layer.name, "reason": "Unsupported active effect: " + name})
                operations.append({"layer": layer.name, "type": "style", "kind": name})
        if layer.is_group():
            semantics.append({"group": layer.name, "children": [c.name for c in layer.descendants()]})
    if blockers:
        return {"checksPassed": False, "blockers": blockers, "operations": operations, "semanticLoss": semantics, "versions": versions()}
    reference = psd.topil(apply_icc=False)
    if reference is None:
        raise ValueError("PSD must contain a saved merged reference image")
    # ignore_preview avoids the document's cached merged image. Existing per-layer
    # raster channels remain usable; paths, active effects and adjustments compose.
    full = psd.composite(force=False, ignore_preview=True, apply_icc=False).convert("RGBA")
    comparison = metric(full, reference)
    reference.convert("RGBA").save(output / "reference.png")
    full.save(output / "rendered.png")
    units = []
    policy = request["layerPolicy"]
    if policy == "flatten_document":
        full.save(output / "unit-0000.png")
        units.append({"name": request["name"], "image": "unit-0000.png"})
    elif policy == "flatten_top_level":
        from PIL import Image
        result = Image.new("RGBA", psd.size)
        for layer in psd:
            if not layer.is_visible():
                continue
            if layer.kind in active_adjustments or layer.clipping:
                blockers.append({"layer": layer.name, "reason": "Top-level adjustment/clipping requires flatten_document or an explicit isolated group"})
                continue
            if len(units) >= 32 or (len(units) + 1) * width * height > 64000000:
                raise ValueError("Advanced PSD exceeds 32 raster units / 64 million output pixels")
            image = layer.composite(viewport=(0, 0, width, height), force=False, apply_icc=False)
            if image is None:
                continue
            image = image.convert("RGBA")
            name = "unit-%04d.png" % len(units)
            image.save(output / name)
            result.alpha_composite(image)
            units.append({"name": layer.name, "image": name})
        unit_error = metric(result, full)
        if unit_error["maxPremultipliedError"] >= 3 or unit_error["meanPremultipliedError"] >= .35:
            blockers.append({"layer": "document", "reason": "Isolated raster units do not reproduce backdrop-dependent composition", "metric": unit_error})
    else:
        raise ValueError("Invalid explicit raster layer policy")
    if comparison["maxPremultipliedError"] >= 3 or comparison["meanPremultipliedError"] >= .35:
        blockers.append({"layer": "document", "reason": "Independent renderer differs from the PSD saved reference", "metric": comparison})
    if hashlib.sha256(source.read_bytes()).hexdigest() != before:
        raise ValueError("PSD changed during rasterization")
    return {"checksPassed": not blockers, "blockers": blockers, "operations": operations, "semanticLoss": semantics, "versions": versions(), "units": units, "width": width, "height": height, "comparison": comparison, "savedMergedPreviewUsedForRendering": False, "savedLayerPixelsUsed": True, "applyIcc": False, "clippedToDocumentCanvas": True}


def main():
    versions()
    if len(sys.argv) == 2 and sys.argv[1] == "--check":
        print(json.dumps({"versions": versions(), "python": sys.version.split()[0]}))
        return
    request_file = pathlib.Path(sys.argv[1]).resolve(strict=True)
    if request_file.stat().st_size > 65536:
        raise ValueError("Oversized PSD raster request")
    request = json.loads(request_file.read_text(encoding="utf8"))
    logging.getLogger("psd_tools").setLevel(logging.ERROR)
    with warnings.catch_warnings(record=True) as caught:
        result = render(request)
    result["warnings"] = [str(w.message)[:500] for w in caught[:20]]
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)[:2000]}))
        sys.exit(1)
