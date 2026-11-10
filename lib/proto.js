function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && shift <= 63n) {
    const byte = BigInt(buf[i]);
    i += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      const asNumber = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number(value);
      return { value: asNumber, offset: i };
    }
    shift += 7n;
  }
  throw new Error("truncated varint");
}

function isText(buf) {
  if (buf.length === 0) return true;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] < 32) return false;
  }
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf);
}

function readFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (!field) break;
    if (wire === 0) {
      const v = readVarint(buf, offset);
      offset = v.offset;
      fields.push({ field, value: v.value });
    } else if (wire === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ field, value: buf.readDoubleLE(offset) });
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ field, value: buf.readFloatLE(offset) });
      offset += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      if (offset + len.value > buf.length) break;
      const slice = buf.subarray(offset, offset + len.value);
      offset += len.value;
      fields.push({ field, value: isText(slice) ? slice.toString("utf8") : slice });
    } else {
      break;
    }
  }
  return fields;
}

function fieldsNamed(fields, field) {
  return fields.filter((entry) => entry.field === field);
}

function asMessage(entry) {
  if (!entry || !Buffer.isBuffer(entry.value)) return [];
  return readFields(entry.value);
}

function firstNumber(fields, field) {
  const entry = fields.find((item) => item.field === field && typeof item.value === "number");
  return entry ? entry.value : null;
}

function firstString(fields, field) {
  const entry = fields.find((item) => item.field === field && typeof item.value === "string");
  return entry ? entry.value : null;
}

module.exports = {
  readFields,
  fieldsNamed,
  asMessage,
  firstNumber,
  firstString,
};
