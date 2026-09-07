import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

export type CourseReadiness = "active" | "ready" | "requires-integration";
export type CourseDelivery = "native" | "integration" | "dedicated";

export type CourseTrack = {
  id: string;
  title: string;
  summary: string;
  level: string;
  durationMinutes: number;
  delivery: CourseDelivery;
  readiness: CourseReadiness;
  outcomes: string[];
  requirements: string[];
};

export type CourseCatalog = {
  version: number;
  updatedAt: string;
  tracks: CourseTrack[];
};

const catalogPath = path.resolve(process.env.CATALOG_PATH || "content/course-catalog.yaml");
const allowedReadiness = new Set<CourseReadiness>(["active", "ready", "requires-integration"]);
const allowedDelivery = new Set<CourseDelivery>(["native", "integration", "dedicated"]);

const text = (value: unknown, field: string, max = 500) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} 값이 올바르지 않습니다.`);
  }
  return value.trim();
};

const textList = (value: unknown, field: string, maxItems = 12) => {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} 목록이 올바르지 않습니다.`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 240));
};

export function validateCatalog(value: unknown): CourseCatalog {
  if (!value || typeof value !== "object") throw new Error("카탈로그는 객체여야 합니다.");
  const raw = value as Record<string, unknown>;
  if (!Number.isInteger(raw.version) || Number(raw.version) < 1) throw new Error("version은 1 이상의 정수여야 합니다.");
  if (!Array.isArray(raw.tracks) || raw.tracks.length < 1 || raw.tracks.length > 40) {
    throw new Error("tracks는 1~40개 과정이어야 합니다.");
  }
  const ids = new Set<string>();
  const tracks = raw.tracks.map((candidate, index): CourseTrack => {
    if (!candidate || typeof candidate !== "object") throw new Error(`tracks[${index}]가 올바르지 않습니다.`);
    const item = candidate as Record<string, unknown>;
    const id = text(item.id, `tracks[${index}].id`, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${id}: 과정 ID 형식이 올바르지 않습니다.`);
    if (ids.has(id)) throw new Error(`${id}: 과정 ID가 중복되었습니다.`);
    ids.add(id);
    const delivery = item.delivery as CourseDelivery;
    const readiness = item.readiness as CourseReadiness;
    if (!allowedDelivery.has(delivery)) throw new Error(`${id}: delivery 값이 올바르지 않습니다.`);
    if (!allowedReadiness.has(readiness)) throw new Error(`${id}: readiness 값이 올바르지 않습니다.`);
    const durationMinutes = Number(item.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
      throw new Error(`${id}: durationMinutes는 5~480 사이 정수여야 합니다.`);
    }
    return {
      id,
      title: text(item.title, `${id}.title`, 100),
      summary: text(item.summary, `${id}.summary`),
      level: text(item.level, `${id}.level`, 40),
      durationMinutes,
      delivery,
      readiness,
      outcomes: textList(item.outcomes, `${id}.outcomes`),
      requirements: textList(item.requirements, `${id}.requirements`)
    };
  });
  return {
    version: Number(raw.version),
    updatedAt: text(raw.updatedAt, "updatedAt", 40),
    tracks
  };
}

export async function readCatalog(): Promise<CourseCatalog> {
  return validateCatalog(parse(await fs.readFile(catalogPath, "utf8")));
}

export async function readCatalogYaml() {
  const yaml = await fs.readFile(catalogPath, "utf8");
  return { catalog: validateCatalog(parse(yaml)), yaml };
}

export async function writeCatalogYaml(yaml: string) {
  if (typeof yaml !== "string" || Buffer.byteLength(yaml, "utf8") > 256_000) {
    throw new Error("카탈로그 YAML은 256KB 이하여야 합니다.");
  }
  const catalog = validateCatalog(parse(yaml));
  const normalized = stringify(catalog, { lineWidth: 120 });
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  const temporary = `${catalogPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, normalized, { encoding: "utf8", mode: 0o640 });
  await fs.rename(temporary, catalogPath);
  return catalog;
}
