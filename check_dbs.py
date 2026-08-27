import sqlite3, os, json, sys

for db_file in ['quality-board.db', 'data.db', 'quality.db']:
    if not os.path.exists(db_file):
        print(f'{db_file}: NOT FOUND')
        continue
    size = os.path.getsize(db_file)
    print(f'\n=== {db_file} ({size} bytes) ===')
    try:
        conn = sqlite3.connect(db_file)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = [r[0] for r in cursor.fetchall()]
        if not tables:
            print('  (no tables)')
            conn.close()
            continue
        for t in tables:
            cursor.execute(f'SELECT COUNT(*) FROM [{t}]')
            count = cursor.fetchone()[0]
            cursor.execute(f'PRAGMA table_info([{t}])')
            cols = [(r[1], r[2]) for r in cursor.fetchall()]
            print(f'  {t}: {count} rows, columns: {cols}')
        conn.close()
    except Exception as e:
        print(f'  ERROR: {e}')
        import traceback
        traceback.print_exc()
