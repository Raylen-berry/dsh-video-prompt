#!/usr/bin/env python3
"""Build a read-only JSON inventory for a local image/video corpus."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff",
    ".heic", ".heif", ".avif",
}
VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".flv",
}
SIDECAR_EXTENSIONS = {".json", ".csv", ".tsv", ".txt", ".srt", ".vtt"}
METRIC_KEY_CANDIDATES = ("path", "file", "filename", "asset", "name")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inventory image/video files, duplicates, sidecars, optional metadata, and metrics."
    )
    parser.add_argument("folder", type=Path, help="Folder containing reference media")
    parser.add_argument("--recursive", action="store_true", help="Scan subfolders")
    parser.add_argument(
        "--hash",
        choices=("none", "quick", "full"),
        default="quick",
        help="Fingerprint mode for duplicate detection (default: quick)",
    )
    parser.add_argument(
        "--metrics-csv",
        type=Path,
        help="Optional CSV with a path/file/filename/asset/name column",
    )
    parser.add_argument("--output", type=Path, help="Optional JSON output path")
    return parser.parse_args()


def iso_utc(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def normalize_key(value: str) -> str:
    return value.strip().replace("\\", "/").lstrip("./").casefold()


def fingerprint(path: Path, mode: str, window: int = 1024 * 1024) -> str | None:
    if mode == "none":
        return None

    digest = hashlib.sha256()
    size = path.stat().st_size
    with path.open("rb") as handle:
        if mode == "full" or size <= 2 * window:
            for chunk in iter(lambda: handle.read(window), b""):
                digest.update(chunk)
        else:
            digest.update(handle.read(window))
            handle.seek(max(0, size - window))
            digest.update(handle.read(window))
            digest.update(str(size).encode("ascii"))
    return digest.hexdigest()


def load_metrics(path: Path | None) -> tuple[dict[str, dict[str, str]], list[str]]:
    if path is None:
        return {}, []

    metrics_path = path.expanduser().resolve()
    if not metrics_path.is_file():
        raise SystemExit(f"Metrics CSV not found: {metrics_path}")

    with metrics_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise SystemExit("Metrics CSV has no header")
        lowered = {name.strip().casefold(): name for name in reader.fieldnames}
        key_name = next(
            (lowered[candidate] for candidate in METRIC_KEY_CANDIDATES if candidate in lowered),
            None,
        )
        if key_name is None:
            expected = ", ".join(METRIC_KEY_CANDIDATES)
            raise SystemExit(f"Metrics CSV needs one key column: {expected}")

        indexed: dict[str, dict[str, str]] = {}
        duplicates: list[str] = []
        for row in reader:
            raw_key = row.get(key_name, "")
            key = normalize_key(raw_key)
            if not key:
                continue
            if key in indexed:
                duplicates.append(raw_key)
            indexed[key] = {name: value for name, value in row.items() if name != key_name}
    return indexed, duplicates


def same_stem_sidecars(path: Path) -> list[str]:
    matches = []
    for candidate in path.parent.iterdir():
        if (
            candidate.is_file()
            and candidate.stem == path.stem
            and candidate.suffix.lower() in SIDECAR_EXTENSIONS
        ):
            matches.append(candidate.name)
    return sorted(matches)


def image_metadata(path: Path) -> dict[str, Any] | None:
    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        with Image.open(path) as image:
            return {
                "width": image.width,
                "height": image.height,
                "mode": image.mode,
                "frames": getattr(image, "n_frames", 1),
            }
    except Exception:
        return None


def video_metadata(path: Path, ffprobe: str | None) -> dict[str, Any] | None:
    if ffprobe is None:
        return None

    command = [
        ffprobe,
        "-v", "error",
        "-show_entries",
        "format=duration:stream=index,codec_type,width,height,avg_frame_rate",
        "-of", "json",
        str(path),
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        payload = json.loads(completed.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        return None

    streams = payload.get("streams", [])
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), {})
    duration = payload.get("format", {}).get("duration")
    return {
        "duration_seconds": float(duration) if duration not in (None, "N/A") else None,
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "avg_frame_rate": video_stream.get("avg_frame_rate"),
        "has_audio": any(item.get("codec_type") == "audio" for item in streams),
    }


def metric_match(
    relative_path: str,
    filename: str,
    metrics: dict[str, dict[str, str]],
) -> tuple[dict[str, str] | None, str | None]:
    for candidate in (normalize_key(relative_path), normalize_key(filename)):
        if candidate in metrics:
            return metrics[candidate], candidate
    return None, None


def main() -> int:
    args = parse_args()
    root = args.folder.expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"Not a directory: {root}")

    metrics, duplicate_metric_keys = load_metrics(args.metrics_csv)
    matched_metric_keys: set[str] = set()
    ffprobe = shutil.which("ffprobe")

    iterator = root.rglob("*") if args.recursive else root.glob("*")
    media_paths = []
    for path in iterator:
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
            media_paths.append(path)
    media_paths.sort(key=lambda item: item.relative_to(root).as_posix().casefold())

    items = []
    hash_groups: dict[str, list[int]] = {}
    kind_counters = {"image": 0, "video": 0}
    for path in media_paths:
        suffix = path.suffix.lower()
        kind = "image" if suffix in IMAGE_EXTENSIONS else "video"
        kind_counters[kind] += 1
        relative_path = path.relative_to(root).as_posix()
        stat = path.stat()
        item_fingerprint = fingerprint(path, args.hash)
        item_metrics, matched_key = metric_match(relative_path, path.name, metrics)
        if matched_key:
            matched_metric_keys.add(matched_key)
        technical = image_metadata(path) if kind == "image" else video_metadata(path, ffprobe)
        item = {
            "asset_id": f"{'I' if kind == 'image' else 'V'}{kind_counters[kind]:04d}",
            "path": relative_path,
            "kind": kind,
            "extension": suffix,
            "bytes": stat.st_size,
            "modified_utc": iso_utc(stat.st_mtime),
            "technical": technical,
            "fingerprint_mode": args.hash,
            "fingerprint": item_fingerprint,
            "duplicate_group": None,
            "sidecars": same_stem_sidecars(path),
            "metrics": item_metrics,
        }
        items.append(item)
        if item_fingerprint:
            hash_groups.setdefault(item_fingerprint, []).append(len(items) - 1)

    duplicate_group_count = 0
    for member_indices in hash_groups.values():
        if len(member_indices) < 2:
            continue
        duplicate_group_count += 1
        label = f"D{duplicate_group_count:03d}"
        for member_index in member_indices:
            items[member_index]["duplicate_group"] = label

    warnings = []
    if any(item["kind"] == "image" and item["technical"] is None for item in items):
        warnings.append("Some image metadata was unavailable; Pillow may be missing or a file may be unreadable.")
    if any(item["kind"] == "video" for item in items) and ffprobe is None:
        warnings.append("ffprobe was not found; video duration, dimensions, and audio presence were not collected.")
    if duplicate_metric_keys:
        warnings.append(f"Duplicate metrics keys were overwritten: {sorted(set(duplicate_metric_keys))}")
    unmatched_metrics = sorted(set(metrics) - matched_metric_keys)
    if unmatched_metrics:
        warnings.append(f"Metrics rows without a matching media file: {unmatched_metrics}")

    result = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "recursive": args.recursive,
        "hash_mode": args.hash,
        "metrics_csv": str(args.metrics_csv.expanduser().resolve()) if args.metrics_csv else None,
        "counts": {
            "total": len(items),
            "images": kind_counters["image"],
            "videos": kind_counters["video"],
            "duplicate_groups": duplicate_group_count,
            "metrics_matched": sum(item["metrics"] is not None for item in items),
        },
        "warnings": warnings,
        "items": items,
    }

    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        output = args.output.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
