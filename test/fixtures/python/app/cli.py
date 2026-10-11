import argparse


def cmd_sync(args):
    return args


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers()
    s = sub.add_parser("sync")
    s.set_defaults(run=cmd_sync)
    return parser
