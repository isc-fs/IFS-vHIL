"""vhil/debugattach.py: holding a test's board for an outside debugger (#425)."""
import json
import socket
import threading

from vhil import debugattach as d


def test_parse_takes_board_and_port_only():
    assert d.parse("ecu:3333") == ("ecu", 3333)
    assert d.parse(" ams:1 ") == ("ams", 1)
    for bad in ("", "ecu", "ecu:", ":3333", "ecu:x", "ecu:70000", "ecu:0"):
        assert d.parse(bad) is None


def test_ready_info_copies_the_images_and_names_their_build_trees(tmp_path):
    fw = tmp_path / "fw"
    fw.mkdir()
    app, bl = fw / "AMS.elf", fw / "CAN_BL.elf"
    app.write_bytes(b"app")
    bl.write_bytes(b"bl")
    out = tmp_path / "out"
    out.mkdir()
    info = d.ready_info("ams", 3333, "ams", [app, bl], out)
    assert info["images"] == ["ams.elf", "ams.bootloader.elf"]
    assert (out / "ams.elf").read_bytes() == b"app"
    assert (out / "ams.bootloader.elf").read_bytes() == b"bl"
    assert json.loads(json.dumps(info))["port"] == 3333


def test_the_build_tree_of_a_vhil_fw_image():
    # /vhil/fw/<id>@<ref>/build/X.elf: the tree is /vhil/fw/<id>@<ref>, what
    # the extension maps back to the working tree (sourceFileMap).
    from pathlib import Path
    parts = Path("/vhil/fw/ams@local/build/AMS.elf").parts
    assert str(Path(*parts[:4])) == "/vhil/fw/ams@local"


def test_the_forwarder_pipes_both_ways_and_flags_the_first_client():
    echo = socket.socket()
    echo.bind(("127.0.0.1", 0))
    echo.listen(1)

    def serve():
        c, _ = echo.accept()
        c.sendall(c.recv(100).upper())
        c.close()
    threading.Thread(target=serve, daemon=True).start()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    first = threading.Event()
    threading.Thread(target=d._serve, args=(listener, echo.getsockname()[1], first), daemon=True).start()
    with socket.create_connection(listener.getsockname(), timeout=5) as c:
        assert first.wait(5)
        c.sendall(b"$g#67")
        assert c.recv(100) == b"$G#67"
    listener.close()
