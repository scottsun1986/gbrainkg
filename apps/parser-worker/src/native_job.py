"""Cancellable native format inspection; images spill to disk, not result JSON."""
import json
import hashlib
import resource
import sys
from pathlib import Path
from env_config import env_int
import temp_budget


def serialize(value, directory, counter):
    if isinstance(value, bytes):
        counter[0] += 1
        name = f'blob-{counter[0]}.bin'
        temp_budget.write_bytes(directory / name, value, directory.parent)
        return {'__native_blob__': name}
    if isinstance(value, dict):
        # Image bytes are consumed one at a time by the parent OCR loop.
        result = {}
        for key, item in value.items():
            if key == 'blob' and isinstance(item, bytes):
                digest = hashlib.sha256(item).hexdigest()
                if digest not in counter[1]:
                    counter[0] += 1
                    name = f'blob-{counter[0]}.bin'
                    temp_budget.write_bytes(directory / name, item, directory.parent)
                    counter[1][digest] = name
                result['blob_path'] = counter[1][digest]
            else:
                result[key] = serialize(item, directory, counter)
        return result
    if isinstance(value, (tuple, list)):
        return [serialize(item, directory, counter) for item in value]
    return value


if __name__ == '__main__':
    memory = env_int('PARSER_NATIVE_MEMORY_BYTES', 1536 * 1024 * 1024)
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_CPU, (240, 245))
    resource.setrlimit(resource.RLIMIT_FSIZE, (200 * 1024 * 1024, 200 * 1024 * 1024))
    import main
    operation, source, output, raw_args = sys.argv[1:]
    path, directory, args = Path(source), Path(output), json.loads(raw_args)
    # Subset helpers must use the caller's explicit temporary workspace, even
    # when the parent configured it in process rather than through the env.
    main.UPLOAD_ROOT = directory.parent
    if operation == 'plaintext':
        result = {'markdown': main.extract_plaintext(path.name, path.read_bytes())}
    elif operation == 'docx':
        contract = {}
        markdown, images = main.extract_docx(path, contract, args.get('unit_ids'))
        result = {'markdown': markdown, 'images': images, 'contract': contract}
    elif operation == 'pptx':
        contract = {}
        blocks, images = main.extract_pptx_native(path, contract, args.get('unit_ids'))
        result = {'blocks': blocks, 'images': images, 'contract': contract}
    elif operation == 'pdf_native':
        result = main.inspect_pdf_native(path)
    elif operation == 'pdf_regions':
        result = main.inspect_pdf_regions(path, set(args['selected']))
    elif operation == 'image':
        result = main.image_units.prepare(path, args.get('unit_ids'))
    elif operation == 'pdf_subset':
        result = {'path': str(main.create_pdf_subset(path, args['pages']))}
    else:
        raise ValueError('Unknown native operation')
    result = serialize(result, directory, [0, {}])
    payload = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(payload.encode()) > 32 * 1024 * 1024:
        raise ValueError('Native parser result exceeds output budget')
    total = sum(p.stat().st_size for p in directory.iterdir())
    if total + len(payload.encode()) > env_int('PARSER_NATIVE_ASSET_BYTES', 200 * 1024 * 1024):
        raise ValueError('Native extracted assets exceed output budget')
    temp_budget.write_text(directory / 'result.json', payload, directory.parent)
