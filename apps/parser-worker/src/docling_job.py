"""One killable Docling job. Only the shared Parser starts this helper."""
import sys

def main():
    import torch
    try:
        compat = torch.library.Library("torchvision", "DEF")
    except RuntimeError:
        compat = torch.library.Library("torchvision", "FRAGMENT")
    for operator in ("nms", "qnms"):
        try:
            compat.define(f"{operator}(Tensor boxes, Tensor scores, float iou_threshold) -> Tensor")
        except RuntimeError:
            pass
    from docling.document_converter import DocumentConverter
    result = DocumentConverter().convert(sys.argv[1])
    # Large model logs go to stderr; stdout is exclusively the artifact.
    from pathlib import Path
    Path(sys.argv[2]).write_text(result.document.export_to_markdown(), encoding="utf-8")

if __name__ == "__main__":
    main()
