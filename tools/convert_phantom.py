"""Development-only conversion; NumPy is never needed by the application."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

MAPS = ("Rho", "T1", "T2", "T2Star")
SOURCE = "https://raw.githubusercontent.com/JonathanArvidsson/EEN200/main/numPhantom/BrainStandardResolution.npz"


def convert(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    offsets = {}
    with np.load(source) as phantom, (destination / "phantom.bin").open("wb") as output:
        shape = phantom["Rho"].shape
        if len(shape) != 3:
            raise ValueError("Expected a three-dimensional phantom")
        for name in MAPS:
            if phantom[name].shape != shape or not np.isfinite(phantom[name]).all():
                raise ValueError(f"Invalid {name} map")
            # Original [row, column, slice] -> contiguous [slice, row, column].
            # imshow uses origin='upper': row 0 remains the top canvas row.
            data = np.ascontiguousarray(phantom[name].transpose(2, 0, 1), dtype="<f4")
            offsets[name] = {"byteOffset": output.tell()}
            output.write(data.tobytes())
    metadata = {
        "version": 1, "file": "phantom.bin", "dtype": "float32-le",
        "layout": "slice-row-column", "width": shape[1], "height": shape[0],
        "slices": shape[2], "sourceShape": list(shape), "sourceAxes": ["row", "column", "slice"],
        "displayOrigin": "upper", "units": "seconds", "maps": offsets,
        "source": SOURCE, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    }
    (destination / "phantom.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Converted {shape}: {(destination / 'phantom.bin').stat().st_size:,} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    args = parser.parse_args()
    convert(args.source, args.output)
