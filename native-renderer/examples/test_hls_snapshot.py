import functools
import http.server
import os
import pathlib
import tempfile
import threading
import unittest
import urllib.request
from contextlib import contextmanager
from unittest.mock import patch

from hls_snapshot import HlsSnapshotHandlerMixin, read_published


class SnapshotTest(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows file-sharing semantics")
    def test_windows_publisher_can_delete_segment_during_actual_file_read(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / "old-segment.ts"
            original = b"published segment bytes"
            target.write_bytes(original)
            opened = threading.Event()
            release = threading.Event()
            real_fdopen = os.fdopen
            received = []
            errors = []

            @contextmanager
            def paused_fdopen(*args, **kwargs):
                with real_fdopen(*args, **kwargs) as source:
                    opened.set()
                    release.wait(5)
                    yield source

            def read():
                try:
                    received.append(read_published(target))
                except BaseException as error:
                    errors.append(error)

            with patch("hls_snapshot.os.fdopen", paused_fdopen):
                reader = threading.Thread(target=read)
                reader.start()
                try:
                    self.assertTrue(opened.wait(5), "reader did not open Windows handle")
                    target.unlink()
                finally:
                    release.set()
                    reader.join(8)
            self.assertFalse(reader.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(received, [original])

    def test_publisher_can_replace_and_delete_while_reader_sends_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            playlist = root / "live.m3u8"
            segment = root / "segment.ts"
            playlist.write_bytes(b"#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n")
            segment.write_bytes(b"old segment")
            snapshot_ready = threading.Event()
            release_reader = threading.Event()

            class Handler(HlsSnapshotHandlerMixin, http.server.SimpleHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def copyfile(self, source, output):
                    snapshot_ready.set()
                    release_reader.wait(5)
                    super().copyfile(source, output)

            server = http.server.ThreadingHTTPServer(
                ("127.0.0.1", 0), functools.partial(Handler, directory=folder))
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            try:
                for name, original, replacement in [
                    ("live.m3u8", playlist.read_bytes(), b"#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n"),
                    ("segment.ts", segment.read_bytes(), b"new segment"),
                ]:
                    received = []
                    errors = []
                    snapshot_ready.clear()
                    release_reader.clear()

                    def read():
                        try:
                            with urllib.request.urlopen(
                                f"http://127.0.0.1:{server.server_port}/{name}", timeout=8
                            ) as response:
                                received.append(response.read())
                        except BaseException as error:
                            errors.append(error)

                    reader = threading.Thread(target=read)
                    reader.start()
                    try:
                        self.assertTrue(snapshot_ready.wait(5), "reader never acquired snapshot")
                        pending = root / (name + ".tmp")
                        pending.write_bytes(replacement)
                        pending.replace(root / name)
                        self.assertEqual((root / name).read_bytes(), replacement)
                        (root / name).unlink()
                    finally:
                        release_reader.set()
                        reader.join(8)
                    self.assertFalse(reader.is_alive())
                    self.assertEqual(errors, [])
                    self.assertEqual(received, [original])
            finally:
                release_reader.set()
                server.shutdown()
                server.server_close()
                serving.join()


if __name__ == "__main__":
    unittest.main()
