import os
from collections import defaultdict

def interactive_cleanup(root_dir):
    files_dict = defaultdict(list)
    for root, dirs, files in os.walk(root_dir):
        for filename in files:
            full_path = os.path.join(root, filename)
            files_dict[full_path.lower()].append(full_path)

    for lower_name, paths in files_dict.items():
        if len(paths) > 1:
            print(f"\n--- 중복 그룹 발견 ---")
            for i, p in enumerate(paths):
                print(f"[{i}] {p}")
            
            choice = input("삭제할 파일 번호를 입력하세요 (여러 개는 콤마로 구분, 건너뛰려면 Enter): ")
            if choice.strip():
                try:
                    indices = [int(x.strip()) for x in choice.split(',')]
                    for idx in indices:
                        os.remove(paths[idx])
                        print(f"삭제 완료: {paths[idx]}")
                except Exception as e:
                    print(f"오류 발생: {e}")

interactive_cleanup('.')
