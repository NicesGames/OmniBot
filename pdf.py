import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
import re
from playwright.async_api import async_playwright

async def url_to_pdf(url, output_dir, custom_filename=None):
    """
    Конвертирует URL в PDF файл используя Playwright
    """
    async with async_playwright() as p:
        # Запускаем браузер (Chromium)
        browser = await p.chromium.launch()
        page = await browser.new_page()
        
        try:
            # Переходим на страницу
            print(f"Загружаем: {url}")
            await page.goto(url, wait_until='networkidle')
            
            # Определяем имя файла
            if custom_filename:
                # Используем пользовательское имя
                filename = custom_filename
            else:
                # Создаем имя файла из URL
                parsed_url = urlparse(url)
                domain = parsed_url.netloc.replace('www.', '')
                path = parsed_url.path.strip('/')
                filename = f"{domain}_{path}".replace('/', '_').replace('\\', '_')
            
            # Очищаем имя файла от недопустимых символов
            filename = re.sub(r'[<>:"|?*]', '_', filename)
            filename = filename[:100] if len(filename) > 100 else filename  # Ограничиваем длину
            filename = f"{filename}.pdf" if not filename.endswith('.pdf') else filename
            
            output_path = output_dir / filename
            
            # Сохраняем как PDF (эквивалент Ctrl+P -> Сохранить как PDF)
            await page.pdf(
                path=str(output_path),
                format='A4',
                print_background=True,  # Включаем фоновые изображения и цвета
                margin={
                    'top': '1cm',
                    'right': '1cm',
                    'bottom': '1cm',
                    'left': '1cm'
                }
            )
            
            print(f"✓ Сохранено: {output_path}")
            return True
            
        except Exception as e:
            print(f"✗ Ошибка при обработке {url}: {str(e)}")
            return False
            
        finally:
            await browser.close()

def parse_line(line):
    """
    Парсит строку и извлекает название и URL
    Поддерживает форматы:
    - * **Название:** https://url.com
    - Название: https://url.com  
    - https://url.com
    """
    line = line.strip()
    
    # Формат: * **Название:** https://url.com
    match = re.search(r'\*\s*\*\*([^*]+)\*\*:\s*(https?://[^\s]+)', line)
    if match:
        title = match.group(1).strip()
        url = match.group(2).strip()
        return title, url
    
    # Формат: Название: https://url.com
    match = re.search(r'^([^:]+):\s*(https?://[^\s]+)', line)
    if match:
        title = match.group(1).strip()
        url = match.group(2).strip()
        return title, url
    
    # Поиск любого URL в строке
    url_match = re.search(r'https?://[^\s]+', line)
    if url_match:
        url = url_match.group(0)
        return None, url
    
    return None, None

async def process_urls_from_file(input_file, output_dir):
    """
    Читает URLs из файла и конвертирует каждый в PDF
    Поддерживает различные форматы строк с названиями и URL
    """
    # Создаем выходную директорию если не существует
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Читаем строки из файла
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            lines = [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        print(f"Файл {input_file} не найден!")
        return
    except Exception as e:
        print(f"Ошибка при чтении файла: {e}")
        return
    
    if not lines:
        print("Файл пустой!")
        return
    
    # Парсим строки и извлекаем названия и URL
    items_to_process = []
    for line in lines:
        title, url = parse_line(line)
        if url:
            items_to_process.append((title, url))
        else:
            print(f"⚠ Не удалось найти URL в строке: {line}")
    
    if not items_to_process:
        print("Не найдено ни одного URL для обработки!")
        return
    
    print(f"Найдено {len(items_to_process)} URL(s) для обработки")
    
    successful = 0
    failed = 0
    
    # Обрабатываем каждый URL
    for i, (title, url) in enumerate(items_to_process, 1):
        # Добавляем протокол если отсутствует
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        
        display_name = title if title else url
        print(f"\n[{i}/{len(items_to_process)}] Обрабатываем: {display_name}")
        print(f"URL: {url}")
        
        # Создаем имя файла из названия если есть
        custom_filename = None
        if title:
            # Очищаем название для использования как имя файла
            clean_title = re.sub(r'[<>:"|?*\\\/]', '_', title)
            clean_title = clean_title.replace('  ', ' ').strip()
            custom_filename = clean_title
        
        success = await url_to_pdf(url, output_dir, custom_filename)
        if success:
            successful += 1
        else:
            failed += 1
        
        # Небольшая пауза между запросами
        await asyncio.sleep(1)
    
    print(f"\n=== Результат ===")
    print(f"Успешно: {successful}")
    print(f"Ошибок: {failed}")
    print(f"PDF файлы сохранены в: {output_dir.absolute()}")

def main():
    """
    Основная функция
    """
    input_file = "url.txt"
    output_dir = "data/messages"
    
    print("=== URL to PDF Converter ===")
    print(f"Входной файл: {input_file}")
    print(f"Выходная папка: {output_dir}")
    
    # Проверяем существование входного файла
    if not os.path.exists(input_file):
        print(f"Создайте файл {input_file} и добавьте в него URLs (по одному на строку)")
        return
    
    # Запускаем асинхронную обработку
    asyncio.run(process_urls_from_file(input_file, output_dir))

if __name__ == "__main__":
    main()