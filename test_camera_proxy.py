import io
import threading
import unittest
from unittest.mock import patch, Mock
from urllib.request import urlopen
from urllib.error import HTTPError, URLError
from app import camera_host, Handler, ThreadingHTTPServer


class CameraProxyTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.url = f'http://127.0.0.1:{self.server.server_port}/api/esp32/stream?host='

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_only_private_literal_addresses(self):
        self.assertEqual(camera_host('192.168.3.58'), '192.168.3.58')
        for host in ('127.0.0.1', '8.8.8.8', '169.254.169.254', 'example.com', '192.168.3.58:81', ''):
            with self.assertRaises(ValueError):
                camera_host(host)
        with self.assertRaises(HTTPError) as error:
            urlopen(self.url + '127.0.0.1')
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_mjpeg_stream_is_passed_through(self):
        data = b'--test\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xff\xd8\xff\xd9\r\n--test--\r\n'
        upstream = io.BytesIO(data)
        upstream.headers = {'Content-Type': 'multipart/x-mixed-replace;boundary=test'}
        with patch('app.build_opener') as factory:
            factory.return_value.open.return_value = upstream
            with urlopen(self.url + '192.168.3.58') as response:
                self.assertEqual(response.read(), data)
                self.assertIn('boundary=test', response.headers['Content-Type'])
            factory.return_value.open.assert_called_once_with('http://192.168.3.58:81/stream', timeout=8)
        self.assertTrue(upstream.closed)

    def test_unreachable_camera_returns_actionable_error(self):
        with patch('app.build_opener') as factory:
            factory.return_value.open.side_effect = URLError('unreachable')
            with self.assertRaises(HTTPError) as error:
                urlopen(self.url + '192.168.3.58')
            self.assertEqual(error.exception.code, 502)
            self.assertIn(b'live firmware', error.exception.read())
            error.exception.close()

    def test_response_timeout_explains_handshake_diagnostics(self):
        with patch('app.build_opener') as factory:
            factory.return_value.open.side_effect = TimeoutError('timed out')
            with self.assertRaises(HTTPError) as error:
                urlopen(self.url + '192.168.3.58')
            self.assertEqual(error.exception.code, 504)
            self.assertIn(b'Live HTTP headers sent', error.exception.read())
            error.exception.close()

    def disconnected_handler(self):
        handler = Handler.__new__(Handler)
        handler.path = '/api/esp32/stream?host=192.168.3.58'
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.log_message = Mock()
        handler.wfile = Mock()
        return handler

    def test_camera_timeout_after_browser_disconnect_does_not_raise(self):
        handler = self.disconnected_handler()
        handler.wfile.write.side_effect = ConnectionAbortedError(10053, 'Browser aborted request')
        with patch('app.build_opener') as factory:
            factory.return_value.open.side_effect = TimeoutError('timed out')
            handler.camera_stream()
        self.assertTrue(handler.close_connection)
        handler.send_response.assert_called_once_with(504)
        handler.log_message.assert_called_once()

    def test_disconnect_while_sending_headers_is_handled(self):
        handler = self.disconnected_handler()
        handler.end_headers.side_effect = ConnectionResetError('Client closed')
        handler.reply(504, {'error': 'Camera timeout'})
        self.assertTrue(handler.close_connection)
        handler.wfile.write.assert_not_called()

    def test_stream_disconnect_during_headers_closes_upstream(self):
        handler = self.disconnected_handler()
        handler.end_headers.side_effect = BrokenPipeError('Client closed')
        upstream = io.BytesIO(b'')
        upstream.headers = {'Content-Type': 'multipart/x-mixed-replace;boundary=test'}
        with patch('app.build_opener') as factory:
            factory.return_value.open.return_value = upstream
            handler.camera_stream()
        self.assertTrue(upstream.closed)

    def test_exposure_control_is_limited_to_known_profiles(self):
        handler = self.disconnected_handler()
        with self.assertRaises(ValueError):
            handler.camera_profile({'host': '192.168.3.58', 'profile': 'invalid'})
        with self.assertRaises(ValueError):
            handler.camera_profile({'host': '127.0.0.1', 'profile': 'fast'})
        response = io.BytesIO(b'{"message":"Fixed exposure applied"}')
        with patch('app.build_opener') as factory:
            factory.return_value.open.return_value = response
            handler.camera_profile({'host': '192.168.3.58', 'profile': 'fast'})
            factory.return_value.open.assert_called_once_with('http://192.168.3.58/control?profile=fast', timeout=5)
        handler.send_response.assert_called_once_with(200)


if __name__ == '__main__':
    unittest.main()
