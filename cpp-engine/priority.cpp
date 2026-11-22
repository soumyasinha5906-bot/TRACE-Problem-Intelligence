#include <algorithm>
#include <cstdlib>
#include <iomanip>
#include <iostream>

int main(int argc, char* argv[]) {
    if (argc != 5) {
        std::cerr << "Usage: priority_engine severity impact frequency duration\n";
        return 1;
    }
    double severity = std::clamp(std::atof(argv[1]), 0.0, 100.0);
    double impact = std::clamp(std::atof(argv[2]), 0.0, 100.0);
    double frequency = std::clamp(std::atof(argv[3]), 0.0, 100.0);
    double duration = std::clamp(std::atof(argv[4]), 0.0, 100.0);

    double score = 0.35 * severity + 0.25 * impact
                 + 0.20 * frequency + 0.20 * duration;

    std::cout << std::fixed << std::setprecision(1) << score << '\n';
    return 0;
}
