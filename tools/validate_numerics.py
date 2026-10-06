"""Validate conversion and JS against the actual reference methods, without its GUI dependencies."""
import argparse
import ast
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CASES = {
    "SE": [{"TR": 1, "TE": 0.1}, {"TR": 4, "TE": 0.02}, {"TR": 0, "TE": 0.005}, {"TR": 20, "TE": 0.2}],
    "IR": [{"TR": 1, "TE": 0.1, "TI": 0}, {"TR": 5, "TE": 0.08, "TI": 1.2}, {"TR": 0, "TE": 0.005, "TI": 0}, {"TR": 20, "TE": 0.2, "TI": 4.5}],
    "GRE": [{"TR": 1, "TE": 0.1, "FA": 90}, {"TR": 0.5, "TE": 0.02, "FA": 30}, {"TR": 0, "TE": 0.001, "FA": 0}, {"TR": 20, "TE": 0.2, "FA": 0}, {"TR": 0, "TE": 0.001, "FA": 90}],
}


def reference_methods():
    tree = ast.parse((ROOT / "tools/reference/MRI_contrast.py").read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef))
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name.startswith("signal_")]
    module = ast.Module(body=methods, type_ignores=[])
    namespace = {"np": np, "deg2rad": np.pi / 180}
    exec(compile(module, "MRI_contrast.py", "exec"), namespace)
    return {"SE": namespace["signal_spin_echo"], "IR": namespace["signal_inversion_recovery"], "GRE": namespace["signal_gradient_echo"]}


def validate(source):
    metadata = json.loads((ROOT / "data/phantom.json").read_text())
    shape = (metadata["slices"], metadata["height"], metadata["width"])
    binary = (ROOT / "data/phantom.bin").read_bytes()
    methods = reference_methods()
    maps = {name: np.frombuffer(binary, dtype="<f4", offset=info["byteOffset"], count=np.prod(shape)).reshape(shape)
            for name, info in metadata["maps"].items()}
    cases = []
    expected = []
    with np.load(source) as phantom:
        for name, values in maps.items():
            # Every voxel, every slice: exact after the intentional Float32 conversion.
            np.testing.assert_array_equal(values, phantom[name].transpose(2, 0, 1).astype("<f4"))
        for index in [0, 17, 50, shape[0] - 1]:
            slices = {name: phantom[name][:, :, index].copy() for name in maps}
            for name in ["T1", "T2", "T2Star"]:
                slices[name][slices[name] == 0] = 1
            for sequence, combinations in CASES.items():
                for parameters in combinations:
                    cases.append({"sequence": sequence, "slice": index, "parameters": parameters})
                    relaxation = slices["T2Star"] if sequence == "GRE" else slices["T2"]
                    with np.errstate(invalid="ignore", divide="ignore"):
                        result = methods[sequence](None, slices["Rho"], slices["T1"], relaxation, **parameters)
                    expected.append(result)
    with tempfile.TemporaryDirectory() as directory:
        case_file = Path(directory) / "cases.json"
        result_file = Path(directory) / "results.bin"
        case_file.write_text(json.dumps(cases))
        subprocess.run(["node", str(ROOT / "tests/run-reference-cases.js"), str(case_file), str(result_file)], check=True)
        actual = np.fromfile(result_file, dtype="<f4").reshape((len(cases), shape[1], shape[2]))
        maximum_error = 0
        for case, reference, calculated in zip(cases, expected, actual):
            np.testing.assert_allclose(calculated, reference, atol=2e-7, rtol=2e-5, equal_nan=True, err_msg=str(case))
            finite = np.isfinite(reference)
            if finite.any():
                maximum_error = max(maximum_error, float(np.max(np.abs(calculated[finite] - reference[finite]))))
    print(f"PASS: all map voxels retain Python orientation; {len(cases)} full-slice comparisons passed.")
    print(f"Maximum absolute raw-signal error: {maximum_error:.3g}; includes zeros, boundaries and GRE singularity.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    validate(parser.parse_args().source)
