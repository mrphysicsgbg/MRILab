"""Check saved ROI persistence through real mobile touches and panel toggles."""
import mimetypes
import argparse
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def run(url=None):
    root = Path(__file__).resolve().parents[1]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        for width in [320, 390, 620]:
            page = browser.new_page(viewport={'width': width, 'height': 844},
                                    is_mobile=True, has_touch=True)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))

            def serve(route):
                path = (root / urlparse(route.request.url).path.lstrip('/')).resolve()
                if path.is_dir():
                    path /= 'index.html'
                if not path.is_relative_to(root) or not path.is_file():
                    route.fulfill(status=404, body='Not found')
                    return
                route.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(path)[0] or 'application/octet-stream')

            if not url:
                page.route('http://mrilab.test/**', serve)
            page.goto(url or 'http://mrilab.test/')
            page.wait_for_function("!document.querySelector('#simulation-controls').disabled")
            assert page.locator('#slice').is_visible()
            page.locator('#mobile-roi-panel > summary').click()
            page.wait_for_function("!document.querySelector('#roi-panel').hidden")
            page.locator('#roi-draw-0').tap()
            box = page.locator('#mri-image').bounding_box()
            x, y = box['x'] + box['width'] * .4, box['y'] + box['height'] * .4
            size = min(box['width'], box['height']) * .15
            session = page.context.new_cdp_session(page)
            session.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
            for px, py in [(x + size, y), (x + size, y + size), (x, y + size), (x, y)]:
                session.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': px, 'y': py}]})
            session.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            page.wait_for_function("document.querySelectorAll('#roi-overlay polygon').length === 1")
            assert 'pixels' in page.locator('#roi-value-0').inner_text()

            for iteration in range(3):
                page.locator('#mobile-roi-panel > summary').click()
                page.wait_for_function("document.querySelector('#roi-panel').hidden")
                assert page.locator('#sequence').is_visible()
                assert page.locator('#slice').is_hidden(), 'Saved ROIs hide the mobile slice selector'
                assert page.locator('#roi-overlay').is_visible(), f'Outline lost at {width}px'
                assert page.locator('#roi-overlay polygon').count() == 1
                assert not page.locator('#roi-drawing-overlay').is_visible(), 'Collapse must hide only the drawing controls'
                if iteration == 0:
                    # Check painted pixels, rather than only SVG nodes/visibility.
                    stage = page.locator('#image-stage')
                    with_roi = stage.screenshot(path=f'/tmp/mrilab-roi-collapsed-{width}.png')
                    page.locator('#roi-overlay').evaluate("el => el.style.visibility = 'hidden'")
                    without_roi = stage.screenshot()
                    page.locator('#roi-overlay').evaluate("el => el.style.removeProperty('visibility')")
                    assert with_roi != without_roi, f'Collapsed ROI is not painted at {width}px'
                page.locator('#mobile-diagram-panel > summary').click()
                page.wait_for_function("!document.querySelector('#diagram-panel').hidden")
                assert page.locator('#sequence-diagram .roi-signal-curve').count() == 1, f'Plot lost at {width}px'
                assert page.locator('#sequence-diagram .roi-image-sample').count() == 1
                page.locator('#mobile-roi-panel > summary').click()
                page.wait_for_function("!document.querySelector('#roi-panel').hidden")

            page.locator('#mobile-roi-panel > summary').click()
            page.wait_for_function("document.querySelector('#roi-panel').hidden")
            page.locator('#mobile-diagram-panel > summary').click()
            page.wait_for_function("!document.querySelector('#diagram-panel').hidden")
            old_curve = page.locator('#sequence-diagram .roi-signal-curve').get_attribute('d')
            page.locator('#parameter-TR').evaluate("el => { el.value = 2; el.dispatchEvent(new Event('input', {bubbles:true})); }")
            page.wait_for_function("(old) => document.querySelector('#sequence-diagram .roi-signal-curve').getAttribute('d') !== old", arg=old_curve)
            assert page.locator('#roi-overlay').is_visible()
            for sequence in ['SE', 'IR', 'GRE']:
                page.select_option('#sequence', sequence)
                page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                page.wait_for_function("document.querySelector('#sequence-diagram .roi-signal-curve') !== null")
                old_sample = page.locator('#sequence-diagram .roi-chart-current').get_attribute('x1')
                page.locator('#parameter-TE').evaluate("el => { el.value = .04; el.dispatchEvent(new Event('input', {bubbles:true})); }")
                page.wait_for_function("(old) => document.querySelector('#sequence-diagram .roi-chart-current').getAttribute('x1') !== old", arg=old_sample)
                assert page.locator('#roi-panel').is_hidden()
                assert page.locator('#sequence-diagram .roi-signal-curve').count() >= 1
                assert page.locator('#roi-overlay').is_visible()
                if sequence == 'IR':
                    assert page.locator('.roi-signal-curve[data-component="longitudinal"]').count() == 2
                    assert page.locator('.roi-signal-curve[data-component="transverse"]').count() == 2
                    page.locator('#sequence-diagram').screenshot(path=f'/tmp/mrilab-stacked-ir-{width}.png')
            page.locator('#mobile-roi-panel > summary').click()
            page.wait_for_function("!document.querySelector('#roi-panel').hidden")
            page.get_by_role('button', name='Delete ROI 1', exact=True).click()
            page.wait_for_function("document.querySelectorAll('#roi-overlay polygon').length === 0")
            assert page.locator('#roi-overlay polygon').count() == 0
            page.locator('#mobile-roi-panel > summary').click()
            page.wait_for_function("document.querySelector('#roi-panel').hidden")
            page.locator('#mobile-diagram-panel > summary').click()
            page.wait_for_function("!document.querySelector('#diagram-panel').hidden")
            assert page.locator('#sequence-diagram .roi-signal-curve').count() == 0
            assert not page.locator('#roi-overlay').is_visible()
            assert page.locator('#slice').is_visible(), 'Clearing all ROIs restores slice selection'
            assert not errors, errors
            print(f'PASS: {width}px mobile touch drawing, repeated collapse, persistent outlines/plots, parameter updates and deletion.', flush=True)
            page.close()
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='Check a running app instead of routing workspace assets.')
    run(parser.parse_args().url)
