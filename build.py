#!/usr/bin/env python3
"""filtered_bus_stops.csv -> data/stops.json (압축 배열)

사용법: python3 build.py
"""
import csv, json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(ROOT, 'filtered_bus_stops.csv')
OUT_PATH = os.path.join(ROOT, 'data', 'stops.json')


def load_stops():
    stops = []
    with open(CSV_PATH, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            try:
                lat, lng = round(float(r['위도']), 6), round(float(r['경도']), 6)
            except (ValueError, KeyError, TypeError):
                continue
            stops.append([r['정류장번호'], r['정류장명'], lat, lng, r['도시명']])
    return stops


def main():
    stops = load_stops()
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(stops, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(stops):,}개 정류장 -> data/stops.json ({os.path.getsize(OUT_PATH)/1024/1024:.1f}MB)')


if __name__ == '__main__':
    main()
