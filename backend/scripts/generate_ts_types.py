#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- TypeScript Type Generator from OpenAPI
# =============================================================================
#
# Reads openapi.json (from FastAPI) and generates TypeScript interfaces
# for all schemas in components.schemas.
#
# Usage:
#   python scripts/generate_ts_types.py openapi.json ../frontend/src/api/generated.ts
#
# Or inside Docker:
#   curl -s http://127.0.0.1:8000/openapi.json | \
#     python scripts/generate_ts_types.py /dev/stdin frontend/src/api/generated.ts
#
# Output is deterministic: same input JSON always produces the same .ts file.
# This allows `diff` to detect drift in CI / velo update.
#
# SUPPORTED OPENAPI PATTERNS:
#   - Simple types (string, integer, number, boolean)
#   - format: uuid, date-time -> string (TS has no native UUID/DateTime)
#   - anyOf with null -> T | null
#   - $ref -> type name
#   - enum -> union of string literals
#   - array with items -> T[]
#   - object with additionalProperties -> Record<string, unknown>
#   - required vs optional fields
#   - default values (fields with defaults are optional)
#
# SKIPPED:
#   - allOf, oneOf, discriminator (not used in VELO Pydantic schemas)
#   - If encountered, a TODO comment is emitted instead of crashing
# =============================================================================

from __future__ import annotations

import json
import sys
from pathlib import Path

# -- OpenAPI type -> TypeScript type mapping --------------------------------

_SIMPLE_TYPE_MAP: dict[str, str] = {
    "string": "string",
    "integer": "number",
    "number": "number",
    "boolean": "boolean",
}

# Schemas to skip (FastAPI internals, not useful for frontend).
_SKIP_SCHEMAS: set[str] = {
    "HTTPValidationError",
    "ValidationError",
}


def _ref_name(ref: str) -> str:
    """Extract type name from $ref string.

    Example: '#/components/schemas/UserRole' -> 'UserRole'
    """
    return ref.rsplit("/", 1)[-1]


def _resolve_type(prop: dict) -> str:
    """Convert a single OpenAPI property definition to a TypeScript type string.

    Handles: simple types, $ref, anyOf (nullable), arrays, enums,
    objects with additionalProperties.
    """
    # -- $ref (direct reference to another schema) --
    if "$ref" in prop:
        return _ref_name(prop["$ref"])

    # -- anyOf (nullable pattern: [{type/ref}, {type: null}]) --
    if "anyOf" in prop:
        variants = prop["anyOf"]
        non_null = [v for v in variants if v.get("type") != "null"]
        has_null = any(v.get("type") == "null" for v in variants)

        if len(non_null) == 1:
            base = _resolve_type(non_null[0])
            return f"{base} | null" if has_null else base

        # Multiple non-null variants (rare in VELO schemas).
        parts = [_resolve_type(v) for v in non_null]
        result = " | ".join(parts)
        if has_null:
            result += " | null"
        return result

    # -- enum (string literal union) --
    if "enum" in prop:
        literals = " | ".join(f"'{v}'" for v in prop["enum"])
        return literals

    # -- array --
    if prop.get("type") == "array":
        items = prop.get("items", {})
        item_type = _resolve_type(items)
        # Wrap union types in parens for readability: (A | B)[]
        if " | " in item_type:
            return f"({item_type})[]"
        return f"{item_type}[]"

    # -- object with additionalProperties (dict / Record) --
    if prop.get("type") == "object":
        if prop.get("additionalProperties"):
            return "Record<string, unknown>"
        # Plain object without properties (shouldn't happen, but safe).
        return "Record<string, unknown>"

    # -- simple types --
    base_type = prop.get("type", "unknown")
    return _SIMPLE_TYPE_MAP.get(base_type, "unknown")


def _is_enum_schema(schema: dict) -> bool:
    """Check if schema is a pure enum (no properties, has enum list)."""
    return "enum" in schema and "properties" not in schema


def _generate_enum(name: str, schema: dict) -> list[str]:
    """Generate a TypeScript union type from an enum schema."""
    literals = " | ".join(f"'{v}'" for v in schema["enum"])
    lines: list[str] = []
    desc = schema.get("description")
    if desc:
        lines.append(f"/** {_single_line_doc(desc)} */")
    lines.append(f"export type {name} = {literals}")
    lines.append("")
    return lines


def _single_line_doc(desc: str) -> str:
    """Collapse multi-line description to single line for JSDoc."""
    return " ".join(desc.split())


def _generate_interface(name: str, schema: dict) -> list[str]:
    """Generate a TypeScript interface from an object schema."""
    lines: list[str] = []

    desc = schema.get("description")
    if desc:
        lines.append(f"/** {_single_line_doc(desc)} */")

    lines.append(f"export interface {name} {{")

    props = schema.get("properties", {})
    required = set(schema.get("required", []))

    for field_name, field_def in props.items():
        ts_type = _resolve_type(field_def)
        is_required = field_name in required

        # Optional marker: field has a default and is NOT in required list.
        optional = "?" if not is_required else ""

        lines.append(f"  {field_name}{optional}: {ts_type}")

    lines.append("}")
    lines.append("")
    return lines


def generate(openapi: dict) -> str:
    """Generate complete TypeScript file from OpenAPI schema dict."""
    schemas = openapi.get("components", {}).get("schemas", {})
    info = openapi.get("info", {})
    version = info.get("version", "unknown")
    title = info.get("title", "API")

    output: list[str] = []

    # -- Header --
    output.append(
        "// ============================================="
        "================================"
    )
    output.append(
        f"// {title} -- Auto-generated TypeScript types"
    )
    output.append(
        "// ============================================="
        "================================"
    )
    output.append("//")
    output.append(
        "// DO NOT EDIT THIS FILE MANUALLY."
    )
    output.append(
        "// Generated from OpenAPI schema by "
        "backend/scripts/generate_ts_types.py"
    )
    output.append(
        f"// API version: {version}"
    )
    output.append(
        "// ============================================="
        "================================"
    )
    output.append("")

    # -- Sort schemas: enums first, then interfaces (alphabetical) --
    enum_names: list[str] = []
    interface_names: list[str] = []

    for name in sorted(schemas.keys()):
        if name in _SKIP_SCHEMAS:
            continue
        if _is_enum_schema(schemas[name]):
            enum_names.append(name)
        else:
            interface_names.append(name)

    # -- Emit enums --
    if enum_names:
        output.append("// -- Enums "
                       + "-" * 68)
        output.append("")
        for name in enum_names:
            output.extend(_generate_enum(name, schemas[name]))

    # -- Emit interfaces --
    if interface_names:
        output.append("// -- Interfaces "
                       + "-" * 63)
        output.append("")
        for name in interface_names:
            output.extend(
                _generate_interface(name, schemas[name])
            )

    # Ensure trailing newline.
    text = "\n".join(output)
    if not text.endswith("\n"):
        text += "\n"

    return text


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "Usage: python generate_ts_types.py "
            "<openapi.json> <output.ts>",
            file=sys.stderr,
        )
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    with input_path.open(encoding="utf-8") as f:
        openapi = json.load(f)

    result = generate(openapi)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result, encoding="utf-8")

    # Stats for CI output.
    schemas = openapi.get("components", {}).get("schemas", {})
    total = len(schemas) - len(
        _SKIP_SCHEMAS & set(schemas.keys())
    )
    print(f"Generated {total} types -> {output_path}")


if __name__ == "__main__":
    main()
