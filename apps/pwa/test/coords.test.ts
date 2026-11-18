import { describe, expect, test } from "bun:test";
import { containBox, mapPoint } from "../src/lib/coords";

describe("coords", () => {
  const rect = { left: 100, top: 50, width: 800, height: 400 };
  test("letterbox horizontal (frame plus haute que large relativement)", () => {
    // frame 1280x800 dans 800x400 -> échelle 0.5, image 640x400 centrée, marge 80 px à gauche
    expect(containBox(rect, 1280, 800)).toEqual({ left: 180, top: 50, width: 640, height: 400 });
  });
  test("coin haut-gauche de l'image -> 0,0", () => {
    expect(mapPoint(180, 50, rect, 1280, 800)).toEqual({ x: 0, y: 0 });
  });
  test("centre -> centre de la frame", () => {
    expect(mapPoint(500, 250, rect, 1280, 800)).toEqual({ x: 640, y: 400 });
  });
  test("coin bas-droit", () => {
    expect(mapPoint(820, 450, rect, 1280, 800)).toEqual({ x: 1280, y: 800 });
  });
  test("clic dans la bande noire -> null", () => {
    expect(mapPoint(120, 200, rect, 1280, 800)).toBeNull();
  });
  test("letterbox vertical", () => {
    // frame 400x800 (téléphone) dans 800x400 -> échelle 0.5, image 200x400, left = 100 + 300
    expect(mapPoint(400, 50, rect, 400, 800)).toEqual({ x: 0, y: 0 });
    expect(mapPoint(600, 450, rect, 400, 800)).toEqual({ x: 400, y: 800 });
  });
  test("frame vide", () => {
    expect(mapPoint(500, 250, rect, 0, 0)).toBeNull();
  });
});
