"""Close published-file handles before serving HLS to slow clients."""

import io
import os
import urllib.parse


def read_published(path):
    if os.name != "nt":
        with open(path, "rb") as source:
            return source.read()

    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                       wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    # GENERIC_READ, SHARE_READ | SHARE_WRITE | SHARE_DELETE, OPEN_EXISTING.
    handle = create(os.fspath(path), 0x80000000, 7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        close(handle)
        raise
    # fd owns the HANDLE now. Close before any slow network writes.
    with os.fdopen(fd, "rb") as source:
        return source.read()


class HlsSnapshotHandlerMixin:
    def send_head(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.endswith((".m3u8", ".ts")):
            return super().send_head()
        filename = self.translate_path(self.path)
        try:
            payload = read_published(filename)
        except OSError:
            self.send_error(404, "HLS file unavailable")
            return None
        self.send_response(200)
        self.send_header("Content-type", self.guess_type(filename))
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        return io.BytesIO(payload)
